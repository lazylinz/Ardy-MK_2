#ifndef TV_PONG_H
#define TV_PONG_H

#include <LiquidCrystal_I2C.h>

void tvPongInit(LiquidCrystal_I2C* display);
void tvPongUpdate();

#endif