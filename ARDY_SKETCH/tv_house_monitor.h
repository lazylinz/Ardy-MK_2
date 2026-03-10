#ifndef TV_HOUSE_MONITOR_H
#define TV_HOUSE_MONITOR_H

#include <LiquidCrystal_I2C.h>

void tvHouseMonitorInit(LiquidCrystal_I2C* display);
void tvHouseMonitorUpdate();

// State setters
void tvHouseMonitorSetFanState(bool on);
void tvHouseMonitorSetLightBrightness(uint8_t brightness); // 0..100
void tvHouseMonitorSetLightWarmness(uint8_t warmness);     // 0..100

#endif