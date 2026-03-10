#include "tv_pong.h"

#include <Arduino.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// ============================================================
// Internal display handle
// ============================================================
static LiquidCrystal_I2C* lcd = nullptr;

// ============================================================
// LCD geometry
// ============================================================
static const int LCD_COLS = 16;
static const int LCD_ROWS = 2;

static const int PIX_W = LCD_COLS * 5;
static const int PIX_H = LCD_ROWS * 8;

// ============================================================
// Framebuffer and CGRAM cache
// ============================================================
static uint8_t fb[PIX_H][PIX_W];
static byte glyphData[8][8];
static int glyphCount = 0;

// ============================================================
// Pong config
// ============================================================
static const int PADDLE_H = 5;
static const int PADDLE_X_LEFT = 0;
static const int PADDLE_X_RIGHT = PIX_W - 1;

// Variable ball size
static const int BALL_W = 2;
static const int BALL_H = 2;

// Paddle AI feel
static const int PADDLE_DEADZONE = 1;
static const int PADDLE_MAX_STEP = 1;
static const int PADDLE_THINK_INTERVAL = 2;
static const int PADDLE_IDLE_DRIFT_CHANCE = 8; // percent

// Timing and speed
static const unsigned long FRAME_DELAY = 90; // ms
static const int BALL_MOVE_INTERVAL_START = 2;
static const int BALL_MOVE_INTERVAL_MIN = 1;
static const int HITS_TO_SPEED_UP = 2;

// ============================================================
// Game state
// ============================================================
static int leftPaddleY = (PIX_H - PADDLE_H) / 2;
static int rightPaddleY = (PIX_H - PADDLE_H) / 2;

static int ballX = (PIX_W - BALL_W) / 2;
static int ballY = (PIX_H - BALL_H) / 2;
static int ballVX = 1;
static int ballVY = 1;

static int ballMoveInterval = BALL_MOVE_INTERVAL_START;
static int ballFrameCounter = 0;
static int paddleHitCount = 0;
static int aiTick = 0;

static unsigned long lastFrame = 0;

// ============================================================
// Helpers
// ============================================================
static int clampInt(int v, int lo, int hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

static int signInt(int v) {
  if (v < 0) return -1;
  if (v > 0) return 1;
  return 0;
}

static bool rangesOverlap(int a0, int a1, int b0, int b1) {
  return (a0 <= b1) && (b0 <= a1);
}

// ============================================================
// Framebuffer helpers
// ============================================================
static void clearFB() {
  for (int y = 0; y < PIX_H; y++) {
    for (int x = 0; x < PIX_W; x++) {
      fb[y][x] = 0;
    }
  }
}

static void setPixel(int x, int y, bool on = true) {
  if (x < 0 || x >= PIX_W || y < 0 || y >= PIX_H) return;
  fb[y][x] = on ? 1 : 0;
}

static void drawPaddle(int x, int topY) {
  for (int i = 0; i < PADDLE_H; i++) {
    setPixel(x, topY + i, true);
  }
}

static void drawBall(int x, int y) {
  for (int dy = 0; dy < BALL_H; dy++) {
    for (int dx = 0; dx < BALL_W; dx++) {
      setPixel(x + dx, y + dy, true);
    }
  }
}

static void drawCenterLine() {
  int midX = PIX_W / 2;
  for (int y = 0; y < PIX_H; y += 2) {
    setPixel(midX, y, true);
  }
}

// ============================================================
// Ball behavior
// ============================================================
static void randomizeBallVertical() {
  int r = random(0, 5);
  switch (r) {
    case 0: ballVY = -2; break;
    case 1: ballVY = -1; break;
    case 2: ballVY = 1;  break;
    case 3: ballVY = 2;  break;
    default: ballVY = (random(0, 2) == 0) ? -1 : 1; break;
  }
}

static void resetBall(int dirX) {
  ballX = (PIX_W - BALL_W) / 2;
  ballY = random(0, PIX_H - BALL_H + 1);

  ballVX = dirX;
  randomizeBallVertical();

  ballMoveInterval = BALL_MOVE_INTERVAL_START;
  ballFrameCounter = 0;
  paddleHitCount = 0;
}

static void maybeSpeedUpBall() {
  if (paddleHitCount > 0 && (paddleHitCount % HITS_TO_SPEED_UP) == 0) {
    if (ballMoveInterval > BALL_MOVE_INTERVAL_MIN) {
      ballMoveInterval--;
    }
  }
}

static void applyPaddleBounce(bool hitLeftPaddle) {
  int paddleY = hitLeftPaddle ? leftPaddleY : rightPaddleY;
  int paddleCenter = paddleY + (PADDLE_H / 2);
  int ballCenter = ballY + (BALL_H / 2);

  int offset = ballCenter - paddleCenter;

  if (offset <= -2) {
    ballVY = -2;
  } else if (offset == -1) {
    ballVY = -1;
  } else if (offset == 0) {
    ballVY = (random(0, 100) < 50) ? -1 : 1;
  } else if (offset == 1) {
    ballVY = 1;
  } else {
    ballVY = 2;
  }

  ballVX = hitLeftPaddle ? 1 : -1;

  paddleHitCount++;
  maybeSpeedUpBall();
}

// ============================================================
// Paddle AI
// ============================================================
static void updateOnePaddleAI(int& paddleY) {
  int paddleCenter = paddleY + (PADDLE_H / 2);
  int targetY = ballY + (BALL_H / 2) + random(-1, 2);
  int diff = targetY - paddleCenter;

  if (abs(diff) <= PADDLE_DEADZONE) {
    if (random(0, 100) < PADDLE_IDLE_DRIFT_CHANCE) {
      paddleY += random(-1, 2);
    }
  } else {
    int step = clampInt(abs(diff), 0, PADDLE_MAX_STEP);
    paddleY += signInt(diff) * step;
  }

  paddleY = clampInt(paddleY, 0, PIX_H - PADDLE_H);
}

static void updateAI() {
  aiTick++;
  if (aiTick < PADDLE_THINK_INTERVAL) return;
  aiTick = 0;

  updateOnePaddleAI(leftPaddleY);
  updateOnePaddleAI(rightPaddleY);
}

// ============================================================
// Ball update
// ============================================================
static void updateBallOnce() {
  ballX += ballVX;
  ballY += ballVY;

  if (ballY <= 0) {
    ballY = 0;
    ballVY = abs(ballVY);
  }

  if (ballY + BALL_H - 1 >= PIX_H - 1) {
    ballY = PIX_H - BALL_H;
    ballVY = -abs(ballVY);
  }

  int ballTop = ballY;
  int ballBottom = ballY + BALL_H - 1;

  if (ballVX < 0 && ballX <= PADDLE_X_LEFT + 1) {
    int paddleTop = leftPaddleY;
    int paddleBottom = leftPaddleY + PADDLE_H - 1;

    if (rangesOverlap(ballTop, ballBottom, paddleTop, paddleBottom)) {
      ballX = PADDLE_X_LEFT + 1;
      applyPaddleBounce(true);
    }
  }

  if (ballVX > 0 && ballX + BALL_W - 1 >= PADDLE_X_RIGHT - 1) {
    int paddleTop = rightPaddleY;
    int paddleBottom = rightPaddleY + PADDLE_H - 1;

    if (rangesOverlap(ballTop, ballBottom, paddleTop, paddleBottom)) {
      ballX = PADDLE_X_RIGHT - BALL_W;
      applyPaddleBounce(false);
    }
  }

  if (ballX + BALL_W - 1 < 0) {
    resetBall(1);
  }

  if (ballX >= PIX_W) {
    resetBall(-1);
  }
}

static void updateBall() {
  ballFrameCounter++;
  if (ballFrameCounter < ballMoveInterval) return;
  ballFrameCounter = 0;

  updateBallOnce();
}

static void updateGame() {
  updateAI();
  updateBall();
}

// ============================================================
// LCD cell rendering
// ============================================================
static bool sameCell(const byte a[8], const byte b[8]) {
  for (int i = 0; i < 8; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

static bool isCellEmpty(const byte cell[8]) {
  for (int i = 0; i < 8; i++) {
    if (cell[i] != 0) return false;
  }
  return true;
}

static void buildCellBitmap(int cellX, int cellY, byte out[8]) {
  int px0 = cellX * 5;
  int py0 = cellY * 8;

  for (int row = 0; row < 8; row++) {
    byte bits = 0;
    for (int col = 0; col < 5; col++) {
      if (fb[py0 + row][px0 + col]) {
        bits |= (1 << (4 - col));
      }
    }
    out[row] = bits;
  }
}

static void renderLCD() {
  byte tempCell[8];
  int screenMap[LCD_ROWS][LCD_COLS];

  glyphCount = 0;

  for (int r = 0; r < LCD_ROWS; r++) {
    for (int c = 0; c < LCD_COLS; c++) {
      screenMap[r][c] = -1;
    }
  }

  for (int row = 0; row < LCD_ROWS; row++) {
    for (int col = 0; col < LCD_COLS; col++) {
      buildCellBitmap(col, row, tempCell);

      if (isCellEmpty(tempCell)) {
        screenMap[row][col] = -1;
        continue;
      }

      int found = -1;
      for (int g = 0; g < glyphCount; g++) {
        if (sameCell(tempCell, glyphData[g])) {
          found = g;
          break;
        }
      }

      if (found >= 0) {
        screenMap[row][col] = found;
      } else if (glyphCount < 8) {
        for (int i = 0; i < 8; i++) {
          glyphData[glyphCount][i] = tempCell[i];
        }
        screenMap[row][col] = glyphCount;
        glyphCount++;
      } else {
        screenMap[row][col] = 0;
      }
    }
  }

  for (int g = 0; g < glyphCount; g++) {
    lcd->createChar(g, glyphData[g]);
  }

  for (int row = 0; row < LCD_ROWS; row++) {
    lcd->setCursor(0, row);
    for (int col = 0; col < LCD_COLS; col++) {
      if (screenMap[row][col] < 0) {
        lcd->print(' ');
      } else {
        lcd->write((uint8_t)screenMap[row][col]);
      }
    }
  }
}

// ============================================================
// Scene draw
// ============================================================
static void drawScene() {
  clearFB();
  drawCenterLine();
  drawPaddle(PADDLE_X_LEFT, leftPaddleY);
  drawPaddle(PADDLE_X_RIGHT, rightPaddleY);
  drawBall(ballX, ballY);
}

// ============================================================
// Public API
// ============================================================
void tvPongInit(LiquidCrystal_I2C* display) {
  lcd = display;
  if (!lcd) return;

  leftPaddleY = (PIX_H - PADDLE_H) / 2;
  rightPaddleY = (PIX_H - PADDLE_H) / 2;

  ballMoveInterval = BALL_MOVE_INTERVAL_START;
  ballFrameCounter = 0;
  paddleHitCount = 0;
  aiTick = 0;
  lastFrame = 0;

  randomSeed(analogRead(A0) + micros());
  resetBall((random(0, 2) == 0) ? -1 : 1);

  lcd->clear();
}

void tvPongUpdate() {
  if (!lcd) return;

  unsigned long now = millis();
  if (now - lastFrame < FRAME_DELAY) return;
  lastFrame = now;

  updateGame();
  drawScene();
  renderLCD();
}