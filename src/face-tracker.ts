import { FaceDetector, FilesetResolver, type Detection } from '@mediapipe/tasks-vision';
import { isMobileDevice } from './device';

export interface FacePose {
  x: number;
  y: number;
  width: number;
  roll: number;
  visible: boolean;
}

const INFERENCE_INTERVAL_MS = 1000 / (isMobileDevice() ? 8 : 12);
const SMOOTHING = isMobileDevice() ? 0.28 : 0.22;

const EMPTY_POSE: FacePose = {
  x: 0,
  y: 0.35,
  width: 0.35,
  roll: 0,
  visible: false,
};

export class FaceTracker {
  private readonly detector: FaceDetector;
  private pose: FacePose = { ...EMPTY_POSE };
  private lastInferenceAt = -Infinity;

  private constructor(detector: FaceDetector) {
    this.detector = detector;
  }

  static async create(): Promise<FaceTracker> {
    const vision = await FilesetResolver.forVisionTasks('/wasm');
    const options = {
      baseOptions: { modelAssetPath: '/models/blaze_face_short_range.tflite' },
      runningMode: 'VIDEO' as const,
      minDetectionConfidence: 0.5,
      minSuppressionThreshold: 0.3,
    };

    let detector: FaceDetector;
    try {
      detector = await FaceDetector.createFromOptions(vision, {
        ...options,
        baseOptions: { ...options.baseOptions, delegate: 'GPU' },
      });
    } catch {
      detector = await FaceDetector.createFromOptions(vision, options);
    }

    return new FaceTracker(detector);
  }

  update(video: HTMLVideoElement, now: number): FacePose {
    if (
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      now - this.lastInferenceAt < INFERENCE_INTERVAL_MS
    ) {
      return this.pose;
    }

    this.lastInferenceAt = now;
    const detection = this.detector.detectForVideo(video, now).detections[0];

    if (!detection) {
      this.pose = { ...this.pose, visible: false };
      return this.pose;
    }

    const next = this.toPose(detection, video);
    this.pose = this.pose.visible
      ? {
          x: this.lerp(this.pose.x, next.x),
          y: this.lerp(this.pose.y, next.y),
          width: this.lerp(this.pose.width, next.width),
          roll: this.lerpAngle(this.pose.roll, next.roll),
          visible: true,
        }
      : next;

    return this.pose;
  }

  close(): void {
    this.detector.close();
  }

  private toPose(detection: Detection, video: HTMLVideoElement): FacePose {
    const leftEye = this.keypoint(detection, ['leftEye', 'left_eye'], 1);
    const rightEye = this.keypoint(detection, ['rightEye', 'right_eye'], 0);
    const box = detection.boundingBox;

    if (leftEye && rightEye) {
      const left = this.project(leftEye, video);
      const right = this.project(rightEye, video);
      const [from, to] = left.x < right.x ? [left, right] : [right, left];
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const eyeSpan = Math.max(Math.hypot(dx, dy), 0.001);
      const viewportAspect = window.innerWidth / Math.max(window.innerHeight, 1);
      const lift = eyeSpan * 0.95;
      const forehead = {
        x: (from.x + to.x) / 2 - (dy / eyeSpan) * lift,
        y: (from.y + to.y) / 2 + (dx / eyeSpan) * lift,
      };

      return {
        x: forehead.x,
        y: forehead.y,
        width: Math.max(eyeSpan * viewportAspect * 2.1, box ? this.boxWidth(box, video) : eyeSpan),
        roll: Math.atan2(dy, dx * viewportAspect),
        visible: true,
      };
    }

    if (!box) return { ...EMPTY_POSE };

    const mid = this.project(
      {
        x: (box.originX + box.width / 2) / (video.videoWidth || 1),
        y: box.originY / (video.videoHeight || 1),
      },
      video,
    );
    return {
      x: mid.x,
      y: mid.y,
      width: this.boxWidth(box, video),
      roll: 0,
      visible: true,
    };
  }

  private boxWidth(
    box: { originX: number; width: number },
    video: HTMLVideoElement,
  ): number {
    const sourceWidth = video.videoWidth || window.innerWidth;
    const viewportAspect = window.innerWidth / Math.max(window.innerHeight, 1);
    return (box.width / sourceWidth) * 2 * viewportAspect;
  }

  private keypoint(
    detection: Detection,
    names: string[],
    fallbackIndex: number,
  ): Detection['keypoints'][number] | undefined {
    const named = detection.keypoints.find((point) => point.label && names.includes(point.label));
    return named ?? detection.keypoints[fallbackIndex];
  }

  private project(
    landmark: { x: number; y: number },
    video: HTMLVideoElement,
  ): { x: number; y: number } {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const sourceWidth = video.videoWidth || viewportWidth;
    const sourceHeight = video.videoHeight || viewportHeight;
    const fitScale = Math.min(viewportWidth / sourceWidth, viewportHeight / sourceHeight);
    const displayedWidth = sourceWidth * fitScale;
    const displayedHeight = sourceHeight * fitScale;
    const offsetX = (viewportWidth - displayedWidth) / 2;
    const offsetY = (viewportHeight - displayedHeight) / 2;
    const pixelX = (1 - landmark.x) * displayedWidth + offsetX;
    const pixelY = landmark.y * displayedHeight + offsetY;

    return {
      x: (pixelX / viewportWidth) * 2 - 1,
      y: 1 - (pixelY / viewportHeight) * 2,
    };
  }

  private lerp(current: number, next: number): number {
    return current + (next - current) * SMOOTHING;
  }

  private lerpAngle(current: number, next: number): number {
    const delta = Math.atan2(Math.sin(next - current), Math.cos(next - current));
    return current + delta * SMOOTHING;
  }
}
