#pragma once

struct AutoMeasureResult {
  float avgVoltage;
  int samplesCollected;
  int stabilizationTimeSec;
  bool cancelled;
};
