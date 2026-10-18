"""Bound OpenCV's own thread pool before loading the CPU pipeline."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import cv2
cv2.setNumThreads(1)
cv2.ocl.setUseOpenCL(False)
from pipeline import main

if __name__ == '__main__':
    raise SystemExit(main())
