#include "tv_house_monitor.h"

#include <Arduino.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

static LiquidCrystal_I2C* lcd = nullptr;

// =========================
// State
// =========================
static bool fanState = false;
static uint8_t lightBrightness = 60; // 0..100
static uint8_t lightWarmness = 55;   // 0..100

static unsigned long lastFrame = 0;
static const unsigned long FRAME_MS = 10;

static uint8_t fanFrame = 0;   // 0..6
static uint8_t bulbFrame = 0;  // LCD slot 4..7

// =========================
// Custom glyph slots
// slot 0    = current fan frame
// slots 4-7 = bulb glow frames
// =========================

// Fan frame 0
static byte fan0[8] = {
  B00000,
  B00000,
  B11000,
  B11111,
  B00011,
  B00000,
  B00000,
  B00000
};

// Fan frame 1
static byte fan1[8] = {
  B00000,
  B01000,
  B11000,
  B10101,
  B00011,
  B00010,
  B00000,
  B00000
};

// Fan frame 2
static byte fan2[8] = {
  B00000,
  B01000,
  B11100,
  B00100,
  B00111,
  B00010,
  B00000,
  B00000
};

// Fan frame 3
static byte fan3[8] = {
  B00000,
  B01100,
  B00100,
  B00100,
  B00100,
  B00110,
  B00000,
  B00000
};

static byte fan4[8] = {
  B00000,
  B00110,
  B00110,
  B00100,
  B01100,
  B01100,
  B00000,
  B00000
};

static byte fan5[8] = {
  B00000,
  B00110,
  B00011,
  B00100,
  B11000,
  B01100,
  B00000,
  B00000
};

static byte fan6[8] = {
  B00000,
  B00010,
  B00011,
  B01110,
  B11000,
  B01000,
  B00000,
  B00000
};

// Bulb glow 0, dim
static byte bulb0[8] = {
  B00100,
  B01010,
  B01010,
  B01110,
  B01110,
  B00100,
  B01110,
  B00000
};

// Bulb glow 1
static byte bulb1[8] = {
  B00100,
  B01010,
  B11011,
  B01110,
  B01110,
  B00100,
  B01110,
  B00000
};

// Bulb glow 2
static byte bulb2[8] = {
  B10101,
  B01010,
  B11011,
  B01110,
  B01110,
  B00100,
  B01110,
  B00100
};

// Bulb glow 3, brightest
static byte bulb3[8] = {
  B10101,
  B01010,
  B11111,
  B01110,
  B11111,
  B00100,
  B01110,
  B00100
};

// Array of pointers to fan frames
static byte* const fanFrames[] = {
  fan0, fan1, fan2, fan3, fan4, fan5, fan6
};

static const uint8_t FAN_FRAME_COUNT = sizeof(fanFrames) / sizeof(fanFrames[0]);

static void loadStaticGlyphs() {
  if (!lcd) return;

  // Only bulb frames stay permanently loaded
  lcd->createChar(4, bulb0);
  lcd->createChar(5, bulb1);
  lcd->createChar(6, bulb2);
  lcd->createChar(7, bulb3);

  // Load initial fan frame into slot 0
  lcd->createChar(0, fanFrames[fanFrame]);
}

static void uploadCurrentFanFrame() {
  if (!lcd) return;
  lcd->createChar(0, fanFrames[fanFrame]);
}

static uint8_t clamp100(uint8_t v) {
  return (v > 100) ? 100 : v;
}

static uint8_t brightnessToBulbFrame(uint8_t b) {
  if (b < 20) return 4;
  if (b < 45) return 5;
  if (b < 75) return 6;
  return 7;
}

static void updateAnimation() {
  // Fan spins only when on
  if (fanState) {
    fanFrame++;
    if (fanFrame >= FAN_FRAME_COUNT) {
      fanFrame = 0;
    }
    uploadCurrentFanFrame();
  }

  // Bulb shimmer; brighter = stronger glow
  uint8_t base = brightnessToBulbFrame(lightBrightness);

  if (lightBrightness == 0) {
    bulbFrame = 4;
    return;
  }

  // Warmer lights shimmer a bit steadier
  int wobbleChance = map(lightWarmness, 0, 100, 35, 12);

  if (random(0, 100) < wobbleChance) {
    if (base > 4 && random(0, 2) == 0) {
      bulbFrame = base - 1;
    } else {
      bulbFrame = base;
    }
  } else {
    bulbFrame = base;
  }
}

static void drawFanRow() {
  lcd->setCursor(0, 0);
  lcd->write((uint8_t)0);   // current fan frame always lives in slot 0

  lcd->setCursor(2, 0);
  lcd->print("Fan:");
  lcd->print(fanState ? "ON " : "OFF");
  // lcd->print(" ");
  // lcd->print(fanState ? "1" : "0");
  lcd->print("    ");
}

static void drawLightRow() {
  lcd->setCursor(0, 1);
  lcd->write((uint8_t)bulbFrame);

  lcd->setCursor(2, 1);
  lcd->print("B:");
  if (lightBrightness < 100) lcd->print(" ");
  if (lightBrightness < 10)  lcd->print(" ");
  lcd->print(lightBrightness);

  lcd->print(" W:");
  if (lightWarmness < 100) lcd->print(" ");
  if (lightWarmness < 10)  lcd->print(" ");
  lcd->print(lightWarmness);
}

void tvHouseMonitorInit(LiquidCrystal_I2C* display) {
  lcd = display;
  if (!lcd) return;

  randomSeed(analogRead(A0) + micros());

  fanState = false;
  lightBrightness = 60;
  lightWarmness = 55;

  fanFrame = 0;
  bulbFrame = brightnessToBulbFrame(lightBrightness);
  lastFrame = 0;

  loadStaticGlyphs();
  lcd->clear();
}

void tvHouseMonitorUpdate() {
  if (!lcd) return;

  unsigned long now = millis();
  if (now - lastFrame < FRAME_MS) return;
  lastFrame = now;

  updateAnimation();
  drawFanRow();
  drawLightRow();
}

void tvHouseMonitorSetFanState(bool on) {
  fanState = on;
}

void tvHouseMonitorSetLightBrightness(uint8_t brightness) {
  lightBrightness = clamp100(brightness);
}

void tvHouseMonitorSetLightWarmness(uint8_t warmness) {
  lightWarmness = clamp100(warmness);
}