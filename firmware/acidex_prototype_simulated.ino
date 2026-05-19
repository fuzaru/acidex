#include <Arduino.h>
#include <math.h>

struct AutoMeasureResult {
  float avgVoltage;
  int samplesCollected;
  int stabilizationTimeSec;
  bool cancelled;
};

#ifdef ESP32
#include "USB.h"
#include <Preferences.h>
Preferences prefs;
#endif

#if defined(ESP32) && (!defined(ARDUINO_USB_CDC_ON_BOOT) || (ARDUINO_USB_CDC_ON_BOOT != 1))
#error "Enable USB CDC On Boot in the ESP32-S3 board settings before flashing this sketch."
#endif

// Simulated firmware for app testing without the pH sensor hardware.
// It keeps the same USB CDC serial protocol and JSON fields as the main sketch.

#define SERIAL_PORT Serial

#ifdef ESP32
#ifndef I2C_SDA_PIN
#define I2C_SDA_PIN 8
#endif
#ifndef I2C_SCL_PIN
#define I2C_SCL_PIN 9
#endif
#endif

// ================================================
// ========== CALIBRATION (pH model) =============
// ================================================
// pH = (V - intercept) / slope
// slope is volts per pH (typically negative)
float slope = -0.168971f;
float intercept = 3.783735f;

// Calibration buffer reference points
static const float CAL_PH_LOW = 4.0f;
static const float CAL_PH_HIGH = 7.0f;

// ================================================
// ========== SIMULATION SETTINGS =================
// ================================================
static const float SIM_STABLE_NOISE_V = 0.0012f;
static const float SIM_LIVE_NOISE_V = 0.0045f;
static const float SIM_STATUS_INTERVAL_MS = 1000UL;
static const unsigned long SIM_EQUILIBRIUM_MS = 5000UL;

static const float ADS_LSB_V = 0.000125f;
static const int LED_RED_PIN = 12;
static const unsigned long LED_FAST_BLINK_MS = 250UL;
static const unsigned long LED_SLOW_BLINK_MS = 600UL;

// ================================================
// ========== STABILITY PARAMETERS ===============
// ================================================
#define STABILITY_WINDOW 5
#define STABILITY_THRESHOLD_V 0.003f
#define STABLE_HOLD_SEC 5
#define COLLECT_SEC 5
#define MEASURE_TIMEOUT_SEC 30

// ================================================
// ========== CLASSIFICATION BOUNDARIES ===========
// ================================================
// Decision-stump threshold learned from coffee.csv
#define ACIDIC_THRESHOLD 5.035f
#define GUARD_LOW 4.85f
#define GUARD_HIGH 5.15f

enum class SimMode {
  Idle,
  Measure,
  CalibrationLow,
  CalibrationHigh,
  QuickPH,
  Live,
};

SimMode gMode = SimMode::Idle;
float gTargetPh = 5.04f;
float gNoiseAmplitude = SIM_STABLE_NOISE_V;
uint32_t gScenarioSeed = 1;
unsigned long gScenarioStartMs = 0;

// ================================================
// ========== HELPER FUNCTIONS ====================
// ================================================
uint32_t hashString(const String &value) {
  uint32_t hash = 2166136261u;
  for (size_t i = 0; i < value.length(); i++) {
    hash ^= static_cast<uint8_t>(value[i]);
    hash *= 16777619u;
  }
  return hash;
}

float phToVoltage(float ph) {
  return slope * ph + intercept;
}

float voltageToPH(float voltage) {
  return (voltage - intercept) / slope;
}

float signedNoise(uint32_t seed, int step, float amplitude) {
  uint32_t mixed = seed ^ (0x9E3779B9u * static_cast<uint32_t>(step + 1));
  mixed ^= mixed >> 13;
  mixed *= 1274126177u;
  mixed ^= mixed >> 16;

  float unit = static_cast<float>(mixed & 0xFFFFu) / 65535.0f;
  return (unit * 2.0f - 1.0f) * amplitude;
}

void startScenario(SimMode mode, const String &label, float targetPh, float noiseAmplitude) {
  gMode = mode;
  gTargetPh = targetPh;
  gNoiseAmplitude = noiseAmplitude;
  gScenarioSeed = hashString(label);
  gScenarioStartMs = millis();
}

int16_t simulatedAdcCounts(float voltage) {
  return static_cast<int16_t>(lroundf(voltage / ADS_LSB_V));
}

float simulatedVoltageNow() {
  float base = phToVoltage(gTargetPh);
  unsigned long elapsedMs = millis() - gScenarioStartMs;
  float elapsedSec = static_cast<float>(elapsedMs) / 1000.0f;
  int step = static_cast<int>(elapsedMs / 250UL);

  float approach = 1.0f;
  if (elapsedMs < SIM_EQUILIBRIUM_MS) {
    approach = static_cast<float>(elapsedMs) / static_cast<float>(SIM_EQUILIBRIUM_MS);
  }
  if (approach < 0.0f) approach = 0.0f;
  if (approach > 1.0f) approach = 1.0f;

  float drift =
    0.0005f * sinf(elapsedSec * 0.8f + static_cast<float>(gScenarioSeed % 1000u) / 170.0f) +
    0.0003f * cosf(elapsedSec * 1.3f + static_cast<float>(gScenarioSeed % 700u) / 190.0f);

  float settlingOffset = (1.0f - approach) * 0.020f * sinf(elapsedSec * 2.1f);
  float dynamicNoise = signedNoise(gScenarioSeed, step, gNoiseAmplitude * (1.0f - approach));
  float stableNoise = signedNoise(gScenarioSeed ^ 0xA5A5A5A5u, step, SIM_STABLE_NOISE_V * 0.25f);
  float noise = dynamicNoise + stableNoise;

  return base + settlingOffset + drift * (0.35f + 0.65f * approach) + noise;
}

float readVoltage() {
  return simulatedVoltageNow();
}

float calculateStd(float arr[], int size) {
  float mean = 0;
  for (int i = 0; i < size; i++) mean += arr[i];
  mean /= static_cast<float>(size);

  float sumSq = 0;
  for (int i = 0; i < size; i++) sumSq += (arr[i] - mean) * (arr[i] - mean);
  return sqrt(sumSq / static_cast<float>(size));
}

String classifyPH(float ph) {
  if (ph < ACIDIC_THRESHOLD && ph < GUARD_LOW) return "ACIDIC";
  if (ph > ACIDIC_THRESHOLD && ph > GUARD_HIGH) return "NON_ACIDIC";
  return "UNCERTAIN";
}

void setLedDefault() {
  digitalWrite(LED_RED_PIN, HIGH);
}

bool isTransportConnected() {
#ifdef ESP32
  return static_cast<bool>(SERIAL_PORT) && SERIAL_PORT.dtr();
#else
  return static_cast<bool>(SERIAL_PORT);
#endif
}

void blinkLedDoneThenDefault(unsigned long durationMs = 2000UL) {
  unsigned long start = millis();
  bool ledOn = true;
  digitalWrite(LED_RED_PIN, HIGH);

  while (millis() - start < durationMs) {
    ledOn = !ledOn;
    digitalWrite(LED_RED_PIN, ledOn ? HIGH : LOW);
    delay(LED_SLOW_BLINK_MS);
  }

  setLedDefault();
}

float pickMeasurementPh(const String &sampleId) {
  (void)sampleId;

  // Weighted random buckets so outputs vary realistically per analysis.
  // ~30% acidic, ~45% moderate, ~25% non-acidic.
  int bucket = random(0, 100);
  float minPh = 4.55f;
  float maxPh = 5.85f;

  if (bucket < 30) {
    minPh = 4.55f;
    maxPh = 4.95f;
  } else if (bucket < 75) {
    minPh = 4.96f;
    maxPh = 5.25f;
  } else {
    minPh = 5.26f;
    maxPh = 5.85f;
  }

  long roll = random(0, 10001); // 0..10000
  float unit = static_cast<float>(roll) / 10000.0f;
  return minPh + unit * (maxPh - minPh);
}

AutoMeasureResult measureAutoStable() {
  AutoMeasureResult out;
  out.avgVoltage = NAN;
  out.samplesCollected = 0;
  out.stabilizationTimeSec = 0;
  out.cancelled = false;

  float window[STABILITY_WINDOW] = {0};
  int windIdx = 0;
  int windCount = 0;

  unsigned long startMs = millis();
  unsigned long stableStartMs = 0;
  unsigned long lastStatusMs = 0;
  unsigned long lastBlinkMs = 0;
  bool ledOn = true;
  digitalWrite(LED_RED_PIN, HIGH);

  while (true) {
    if (!isTransportConnected()) {
      out.cancelled = true;
      Serial.println("{\"status\":\"analysis_cancelled\",\"reason\":\"usb_disconnected\"}");
      setLedDefault();
      return out;
    }

    float v = readVoltage();

    if (millis() - lastBlinkMs >= LED_FAST_BLINK_MS) {
      lastBlinkMs = millis();
      ledOn = !ledOn;
      digitalWrite(LED_RED_PIN, ledOn ? HIGH : LOW);
    }

    if (millis() - lastStatusMs >= SIM_STATUS_INTERVAL_MS) {
      lastStatusMs = millis();
      Serial.print("MEASURE_JSON:{\"status\":\"measuring\",\"voltage\":");
      Serial.print(v, 6);
      Serial.print(",\"pH\":");
      Serial.print(voltageToPH(v), 3);
      Serial.println("}");
    }

    window[windIdx] = v;
    windIdx = (windIdx + 1) % STABILITY_WINDOW;
    if (windCount < STABILITY_WINDOW) windCount++;

    if (windCount >= STABILITY_WINDOW) {
      float stdV = calculateStd(window, STABILITY_WINDOW);

      if (stdV < STABILITY_THRESHOLD_V) {
        if (stableStartMs == 0) {
          stableStartMs = millis();
        }

        if (millis() - stableStartMs >= static_cast<unsigned long>(STABLE_HOLD_SEC) * 1000UL) {
          Serial.println("{\"status\":\"stable\"}");

          out.stabilizationTimeSec = static_cast<int>((millis() - startMs) / 1000UL);
          Serial.println("{\"status\":\"collecting\"}");

          float sum = 0;
          int n = 0;
          unsigned long endAvg = millis() + static_cast<unsigned long>(COLLECT_SEC) * 1000UL;
          while (millis() < endAvg) {
            if (!isTransportConnected()) {
              out.cancelled = true;
              Serial.println("{\"status\":\"analysis_cancelled\",\"reason\":\"usb_disconnected\"}");
              setLedDefault();
              return out;
            }
            sum += readVoltage();
            n++;
            delay(50);
          }

          out.samplesCollected = n;
          out.avgVoltage = (n > 0) ? (sum / static_cast<float>(n)) : NAN;
          blinkLedDoneThenDefault();
          return out;
        }
      } else {
        stableStartMs = 0;
      }
    }

    if (millis() - startMs >= static_cast<unsigned long>(MEASURE_TIMEOUT_SEC) * 1000UL) {
      Serial.println("{\"status\":\"unstable_timeout\"}");

      float sum = 0;
      int n = 0;
      unsigned long endAvg = millis() + static_cast<unsigned long>(COLLECT_SEC) * 1000UL;
      while (millis() < endAvg) {
        if (!isTransportConnected()) {
          out.cancelled = true;
          Serial.println("{\"status\":\"analysis_cancelled\",\"reason\":\"usb_disconnected\"}");
          setLedDefault();
          return out;
        }
        sum += readVoltage();
        n++;
        delay(50);
      }

      out.stabilizationTimeSec = static_cast<int>((millis() - startMs) / 1000UL);
      out.samplesCollected = n;
      out.avgVoltage = (n > 0) ? (sum / static_cast<float>(n)) : NAN;
      blinkLedDoneThenDefault();
      return out;
    }

    delay(50);
  }
}

// ================================================
// ========== APP COMMAND HANDLERS ================
// ================================================
void handleCalBuffer(const char *bufferName) {
  if (strcmp(bufferName, "low") == 0) {
    startScenario(SimMode::CalibrationLow, String("cal-low"), 4.00f, SIM_STABLE_NOISE_V);
    Serial.println("{\"status\":\"measuring_low_buffer\"}");
  } else {
    startScenario(SimMode::CalibrationHigh, String("cal-high"), 7.00f, SIM_STABLE_NOISE_V);
    Serial.println("{\"status\":\"measuring_high_buffer\"}");
  }

  AutoMeasureResult m = measureAutoStable();
  if (m.cancelled) return;

  float ph = NAN;
  if (!isnan(m.avgVoltage) && slope != 0.0f && !isnan(slope) && !isnan(intercept)) {
    ph = (m.avgVoltage - intercept) / slope;
  }

  Serial.print("CAL_JSON:{\"buffer\":\"");
  Serial.print(bufferName);
  Serial.print("\",\"voltage\":");
  Serial.print(m.avgVoltage, 6);
  Serial.print(",\"pH\":");
  if (isnan(ph)) {
    Serial.print("null");
  } else {
    Serial.print(ph, 4);
  }
  Serial.print(",\"samplesCollected\":");
  Serial.print(m.samplesCollected);
  Serial.print(",\"stabilizationTimeSec\":");
  Serial.print(m.stabilizationTimeSec);
  Serial.println("}");
}

bool computeAndStoreCalibration(float lowV, float highV) {
  float newSlope = (highV - lowV) / (CAL_PH_HIGH - CAL_PH_LOW);
  float newIntercept = lowV - newSlope * CAL_PH_LOW;

  if (isnan(newSlope) || isnan(newIntercept) || newSlope == 0.0f) {
    return false;
  }

  slope = newSlope;
  intercept = newIntercept;

#ifdef ESP32
  prefs.putFloat("slope", slope);
  prefs.putFloat("intercept", intercept);
#endif

  return true;
}

void handleComputeCalFromVoltages(const String &cmd) {
  int first = cmd.indexOf(' ');
  int second = (first >= 0) ? cmd.indexOf(' ', first + 1) : -1;

  if (first < 0 || second < 0) {
    Serial.println("{\"status\":\"invalid_params\"}");
    return;
  }

  String lowStr = cmd.substring(first + 1, second);
  String highStr = cmd.substring(second + 1);
  float lowV = lowStr.toFloat();
  float highV = highStr.toFloat();

  if (!computeAndStoreCalibration(lowV, highV)) {
    Serial.println("{\"status\":\"invalid_params\"}");
    return;
  }

  Serial.print("CAL_UPDATED_JSON:{\"slope\":");
  Serial.print(slope, 6);
  Serial.print(",\"intercept\":");
  Serial.print(intercept, 6);
  Serial.println("}");
}

void handleMeasure(const String &cmd) {
  String sampleId = "1";
  int first = cmd.indexOf(' ');
  if (first >= 0) {
    sampleId = cmd.substring(first + 1);
    sampleId.trim();
    if (sampleId.length() == 0) sampleId = "1";
  }

  float targetPh = pickMeasurementPh(sampleId);
  startScenario(SimMode::Measure, String("measure:") + sampleId, targetPh, SIM_STABLE_NOISE_V);

  Serial.println("{\"status\":\"ready\"}");

  AutoMeasureResult m = measureAutoStable();
  if (m.cancelled) return;
  float pH = voltageToPH(m.avgVoltage);
  String label = classifyPH(pH);

  Serial.print("RESULT_JSON:{\"sample\":\"");
  Serial.print(sampleId);
  Serial.print("\",\"avgVoltage\":");
  Serial.print(m.avgVoltage, 6);
  Serial.print(",\"pH\":");
  Serial.print(pH, 3);
  Serial.print(",\"samplesCollected\":");
  Serial.print(m.samplesCollected);
  Serial.print(",\"stabilizationTimeSec\":");
  Serial.print(m.stabilizationTimeSec);
  Serial.print(",\"label\":\"");
  Serial.print(label);
  Serial.print("\",\"slope\":");
  Serial.print(slope, 6);
  Serial.print(",\"intercept\":");
  Serial.print(intercept, 6);
  Serial.println("}");
}

void handleQuickPH() {
  startScenario(SimMode::QuickPH, String("quick"), 5.12f, SIM_STABLE_NOISE_V);
  float v = readVoltage();
  float pH = voltageToPH(v);
  Serial.print("PH_JSON:{\"pH\":");
  Serial.print(pH, 3);
  Serial.println("}");
}

void handleLiveStream() {
  startScenario(SimMode::Live, String("live"), 5.12f, SIM_LIVE_NOISE_V);
  Serial.println("{\"status\":\"live_start\"}");

  while (true) {
    if (Serial.available() && Serial.read() == 'X') break;

    float v = readVoltage();
    Serial.print("LIVE_JSON:{\"adc\":");
    Serial.print(simulatedAdcCounts(v));
    Serial.print(",\"voltage\":");
    Serial.print(v, 4);
    Serial.print(",\"pH\":");
    Serial.print(voltageToPH(v), 3);
    Serial.println("}");

    delay(500);
  }

  Serial.println("{\"status\":\"live_stop\"}");
}

void handleGetCal() {
  Serial.print("CAL_CURRENT_JSON:{\"slope\":");
  Serial.print(slope, 6);
  Serial.print(",\"intercept\":");
  Serial.print(intercept, 6);
  Serial.println("}");
}

// ================================================
// ================== SETUP =======================
// ================================================
void setup() {
  pinMode(LED_RED_PIN, OUTPUT);
  setLedDefault();

  Serial.begin(115200);
  Serial.println("{\"status\":\"boot\",\"usbMode\":\"cdc\",\"transport\":\"serial\",\"mode\":\"simulated\"}");

  // Seed RNG once so each app-triggered analysis can produce different pH values.
#ifdef ESP32
  randomSeed(static_cast<unsigned long>(esp_random() ^ micros()));
#else
  randomSeed(static_cast<unsigned long>(micros()));
#endif

#ifdef ESP32
  prefs.begin("acidex", false);
  float storedSlope = prefs.getFloat("slope", slope);
  float storedIntercept = prefs.getFloat("intercept", intercept);
  if (!isnan(storedSlope) && storedSlope != 0.0f && !isnan(storedIntercept)) {
    slope = storedSlope;
    intercept = storedIntercept;
  }
#endif

  startScenario(SimMode::Idle, String("boot"), 5.04f, SIM_STABLE_NOISE_V);
  Serial.println("{\"status\":\"ready\"}");
}

// ================================================
// ================== LOOP ========================
// ================================================
void loop() {
  if (!Serial.available()) return;

  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  if (cmd.length() == 0) return;

  if (cmd == "L") {
    handleCalBuffer("low");
  } else if (cmd == "H") {
    handleCalBuffer("high");
  } else if (cmd.startsWith("C ")) {
    handleComputeCalFromVoltages(cmd);
  } else if (cmd == "M" || cmd.startsWith("M ")) {
    handleMeasure(cmd);
  } else if (cmd == "P") {
    handleQuickPH();
  } else if (cmd == "LIVE") {
    handleLiveStream();
  } else if (cmd == "?") {
    handleGetCal();
  } else {
    Serial.println("{\"error\":\"unknown_command\"}");
  }
}
