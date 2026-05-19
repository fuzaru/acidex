#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_ADS1X15.h>

#ifdef ESP32
#if defined(ESP32) && (!defined(ARDUINO_USB_CDC_ON_BOOT) || (ARDUINO_USB_CDC_ON_BOOT != 1))
#error "Enable USB CDC On Boot in the ESP32-S3 board settings before flashing this sketch."
#endif
#endif

#define SERIAL_PORT Serial

#ifndef I2C_SDA_PIN
#define I2C_SDA_PIN 8
#endif
#ifndef I2C_SCL_PIN
#define I2C_SCL_PIN 9
#endif

static const uint8_t ADS1115_ADDRS[] = { 0x48, 0x49, 0x4A, 0x4B };
static const float ADS_LSB_V = 0.000125f; // GAIN_ONE

Adafruit_ADS1115 ads;
static bool gAdsReady = false;
static unsigned long gLastProbeMs = 0;

void printI2CScan() {
  SERIAL_PORT.println("I2C scan:");
  int found = 0;
  for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      SERIAL_PORT.print("  0x");
      if (addr < 16) SERIAL_PORT.print("0");
      SERIAL_PORT.println(addr, HEX);
      found++;
    }
  }
  if (found == 0) {
    SERIAL_PORT.println("  (no devices found)");
  }
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

void setup() {
  SERIAL_PORT.begin(115200);
  SERIAL_PORT.println("ADS1115 test boot");

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(100000);
  recoverI2CBus();

  printI2CScan();

  uint8_t addr = scanAdsAddress();
  if (addr == 0) {
    SERIAL_PORT.println("ADS1115 not found on 0x48-0x4B");
    return;
  }

  SERIAL_PORT.print("ADS1115 found at 0x");
  SERIAL_PORT.println(addr, HEX);

  if (!ads.begin(addr, &Wire)) {
    SERIAL_PORT.println("ADS1115 begin failed");
    return;
  }

  ads.setGain(GAIN_ONE);
  gAdsReady = true;
  SERIAL_PORT.println("ADS1115 init OK");
}

void loop() {
  if (!gAdsReady) {
    unsigned long now = millis();
    if (now - gLastProbeMs >= 5000UL) {
      gLastProbeMs = now;
      SERIAL_PORT.println("Retrying ADS1115 detection...");
      printI2CScan();

      uint8_t addr = scanAdsAddress();
      if (addr != 0 && ads.begin(addr, &Wire)) {
        ads.setGain(GAIN_ONE);
        gAdsReady = true;
        SERIAL_PORT.print("ADS1115 init OK at 0x");
        SERIAL_PORT.println(addr, HEX);
      } else {
        SERIAL_PORT.println("ADS1115 still not found");
      }
    }
    delay(200);
    return;
  }
  int16_t counts = ads.readADC_SingleEnded(0);
  float voltage = counts * ADS_LSB_V;

  SERIAL_PORT.print("ADC0 counts: ");
  SERIAL_PORT.print(counts);
  SERIAL_PORT.print("  voltage: ");
  SERIAL_PORT.println(voltage, 6);

  delay(500);
}
