#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_ADS1X15.h>

Adafruit_ADS1115 ads;

static const uint8_t ADS1115_ADDRS[] = { 0x48, 0x49, 0x4A, 0x4B };
static const float ADS_LSB_V = 0.000125f; // GAIN_ONE
static bool gAdsReady = false;
static unsigned long gLastProbeMs = 0;

#if defined(ESP32)
static const int I2C_SDA_PIN = 21;
static const int I2C_SCL_PIN = 22;
#endif

void printI2CScan() {
  Serial.println("I2C scan:");
  int found = 0;
  for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.print("  0x");
      if (addr < 16) Serial.print("0");
      Serial.println(addr, HEX);
      found++;
    }
  }
  if (found == 0) {
    Serial.println("  (no devices found)");
  }
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

void setup() {
  Serial.begin(115200);
  Serial.println("ADS1115 test boot (ESP32)");

#if defined(ESP32)
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
#else
  Wire.begin();
#endif

  printI2CScan();

  uint8_t addr = scanAdsAddress();
  if (addr == 0) {
    Serial.println("ADS1115 not found on 0x48-0x4B");
    return;
  }

  Serial.print("ADS1115 found at 0x");
  Serial.println(addr, HEX);

  if (!ads.begin(addr, &Wire)) {
    Serial.println("ADS1115 begin failed");
    return;
  }

  ads.setGain(GAIN_ONE);
  gAdsReady = true;
  Serial.println("ADS1115 init OK");
}

void loop() {
  if (!gAdsReady) {
    unsigned long now = millis();
    if (now - gLastProbeMs >= 5000UL) {
      gLastProbeMs = now;
      Serial.println("Retrying ADS1115 detection...");
      printI2CScan();

      uint8_t addr = scanAdsAddress();
      if (addr != 0 && ads.begin(addr, &Wire)) {
        ads.setGain(GAIN_ONE);
        gAdsReady = true;
        Serial.print("ADS1115 init OK at 0x");
        Serial.println(addr, HEX);
      } else {
        Serial.println("ADS1115 still not found");
      }
    }
    delay(200);
    return;
  }

  int16_t counts = ads.readADC_SingleEnded(0);
  float voltage = counts * ADS_LSB_V;

  Serial.print("ADC0 counts: ");
  Serial.print(counts);
  Serial.print("  voltage: ");
  Serial.println(voltage, 6);

  delay(500);
}
