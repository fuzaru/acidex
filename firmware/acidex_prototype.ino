#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_ADS1X15.h>
#include <math.h>
#include "AutoMeasureResult.h"

#ifdef ESP32
#include "USB.h"
#include <Preferences.h>
Preferences prefs;
#endif

#if defined(ESP32) && (!defined(ARDUINO_USB_CDC_ON_BOOT) || (ARDUINO_USB_CDC_ON_BOOT != 1))
#error "Enable USB CDC On Boot in the ESP32-S3 board settings before flashing this sketch."
#endif

// Use USB CDC as the serial transport so Android sees a standard serial port.
// SERIAL_PORT stays as Serial for the command protocol.
#define SERIAL_PORT Serial

Adafruit_ADS1115 ads;

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
float slope = -0.168971;
float intercept = 3.783735;

// Calibration buffer reference points
static const float CAL_PH_LOW = 4.0f;
static const float CAL_PH_HIGH = 7.0f;

// ADS1115 scaling (GAIN_ONE)
static const float ADS_LSB_V = 0.000125f;
static const int LED_RED_PIN = 12;
static const unsigned long LED_FAST_BLINK_MS = 250UL;
static const unsigned long LED_SLOW_BLINK_MS = 600UL;
static const unsigned long I2C_INIT_RETRY_MS = 120UL;
static const uint8_t ADS1115_ADDRS[] = { 0x48, 0x49, 0x4A, 0x4B };

// ================================================
// ========== STABILITY PARAMETERS ===============
// ================================================
#define STABILITY_WINDOW 5
#define STABILITY_THRESHOLD_V 0.002f
#define STABLE_HOLD_SEC 5
#define COLLECT_SEC 5
#define MEASURE_TIMEOUT_SEC 30
#define MEASURE_STATUS_INTERVAL_MS 1000UL

// ================================================
// ========== CLASSIFICATION BOUNDARIES ===========
// ================================================
float acidicThreshold = 5.035f;
float guardLow = 4.85f;
float guardHigh = 5.15f;

// ================================================
// ========== HELPER FUNCTIONS ====================
// ================================================
int16_t readAdcCounts() {
  return ads.readADC_SingleEnded(0);
}

float readVoltage() {
  return readAdcCounts() * ADS_LSB_V;
}

float voltageToPH(float V) {
  return (V - intercept) / slope;
}

float calculateStd(float arr[], int size) {
  float mean = 0;
  for (int i = 0; i < size; i++) mean += arr[i];
  mean /= (float)size;

  float sumSq = 0;
  for (int i = 0; i < size; i++) sumSq += (arr[i] - mean) * (arr[i] - mean);
  return sqrt(sumSq / (float)size);
}

String classifyPH(float ph) {
  // Guard band around the threshold: treat near-boundary values as uncertain.
  if (ph < acidicThreshold && ph < guardLow) return "ACIDIC";
  if (ph > acidicThreshold && ph > guardHigh) return "NON_ACIDIC";
  return "UNCERTAIN";
}

void setLedDefault() {
  digitalWrite(LED_RED_PIN, HIGH);
}

bool isTransportConnected() {
  // On ESP32 native USB CDC, the boolean operator already checks the DTR signal.
  return (bool)SERIAL_PORT;
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

void recoverI2CBus() {
  pinMode(I2C_SCL_PIN, OUTPUT_OPEN_DRAIN);
  pinMode(I2C_SDA_PIN, INPUT_PULLUP);
  for (int i = 0; i < 9; i++) {
    digitalWrite(I2C_SCL_PIN, HIGH);
    delayMicroseconds(5);
    digitalWrite(I2C_SCL_PIN, LOW);
    delayMicroseconds(5);
  }
  digitalWrite(I2C_SCL_PIN, HIGH);
  delayMicroseconds(5);
}

uint8_t scanAdsAddress() {
  for (uint8_t i = 0; i < sizeof(ADS1115_ADDRS); i++) {
    const uint8_t addr = ADS1115_ADDRS[i];
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      return addr;
    }
  }
  return 0;
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

    if (millis() - lastStatusMs >= MEASURE_STATUS_INTERVAL_MS) {
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

        if (millis() - stableStartMs >= (unsigned long)STABLE_HOLD_SEC * 1000UL) {
          Serial.println("{\"status\":\"stable\"}");

          out.stabilizationTimeSec = (int)((millis() - startMs) / 1000UL);

          // Stable – average for COLLECT_SEC seconds
          Serial.println("{\"status\":\"collecting\"}");

          float sum = 0;
          int n = 0;
          unsigned long endAvg = millis() + (unsigned long)COLLECT_SEC * 1000UL;
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
          out.avgVoltage = (n > 0) ? (sum / (float)n) : NAN;
          blinkLedDoneThenDefault();
          return out;
        }
      } else {
        stableStartMs = 0;  // reset timer on disturbance
      }
    }

    if (millis() - startMs >= (unsigned long)MEASURE_TIMEOUT_SEC * 1000UL) {
      Serial.println("{\"status\":\"unstable_timeout\"}");

      float sum = 0;
      int n = 0;
      unsigned long endAvg = millis() + (unsigned long)COLLECT_SEC * 1000UL;
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

      out.stabilizationTimeSec = (int)((millis() - startMs) / 1000UL);
      out.samplesCollected = n;
      out.avgVoltage = (n > 0) ? (sum / (float)n) : NAN;
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
    Serial.println("{\"status\":\"measuring_low_buffer\"}");
  } else {
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
  // Format: C <lowVoltage> <highVoltage>
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
  // Format: M <sampleId>
  String sampleId = "1";
  int first = cmd.indexOf(' ');
  if (first >= 0) {
    sampleId = cmd.substring(first + 1);
    sampleId.trim();
    if (sampleId.length() == 0) sampleId = "1";
  }

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
  float v = readVoltage();
  float pH = voltageToPH(v);
  Serial.print("PH_JSON:{\"pH\":");
  Serial.print(pH, 3);
  Serial.println("}");
}

void handleLiveStream() {
  Serial.println("{\"status\":\"live_start\"}");
  while (true) {
    if (Serial.available() && Serial.read() == 'X') break;

    float v = readVoltage();
    Serial.print("LIVE_JSON:{\"adc\":");
    Serial.print(readAdcCounts());
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
  Serial.println("{\"status\":\"boot\",\"usbMode\":\"cdc\",\"transport\":\"serial\"}");

  // I2C init
#ifdef ESP32
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(100000);
#else
  Wire.begin();
#endif

  recoverI2CBus();

  uint8_t adsAddr = scanAdsAddress();
  bool adsReady = false;
  for (int attempt = 0; attempt < 5 && !adsReady; attempt++) {
    if (adsAddr == 0) {
      adsAddr = scanAdsAddress();
    }
    if (adsAddr != 0) {
      adsReady = ads.begin(adsAddr, &Wire);
    }
    if (!adsReady) {
      delay(I2C_INIT_RETRY_MS);
      recoverI2CBus();
    }
  }

  if (!adsReady) {
    Serial.println("{\"error\":\"ads1115_not_found\"}");
    while (1) {
      delay(1000);
    }
  }

  ads.setGain(GAIN_ONE);

#ifdef ESP32
  prefs.begin("acidex", false);
  float storedSlope = prefs.getFloat("slope", slope);
  float storedIntercept = prefs.getFloat("intercept", intercept);
  if (!isnan(storedSlope) && storedSlope != 0.0f && !isnan(storedIntercept)) {
    slope = storedSlope;
    intercept = storedIntercept;
  }
#endif

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
