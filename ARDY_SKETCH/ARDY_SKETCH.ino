#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include "tv_house_monitor.h"
#include "WiFiAPWebServer.h"

WiFiAPWebServer webServer;

LiquidCrystal_I2C lcd(0x27, 16, 2);

void setup() {
  lcd.init();
  lcd.backlight();

  webServer.begin();
  Serial.println("UNO role: AP host + local control only.");
  Serial.println("ESP32-CAM role: capture + internet upload.");

  tvHouseMonitorInit(&lcd);

  tvHouseMonitorSetFanState(true);
  tvHouseMonitorSetLightBrightness(78);
  tvHouseMonitorSetLightWarmness(64);
}

void loop() {
  webServer.update();

  tvHouseMonitorUpdate();

  // Example: update these from your real sensors / variables
  // tvHouseMonitorSetFanState(fanOn);
  // tvHouseMonitorSetLightBrightness(brightnessPercent);
  // tvHouseMonitorSetLightWarmness(warmnessPercent);
}
