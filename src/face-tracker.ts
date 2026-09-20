import {
  FaceLandmarker,
  FilesetResolver,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';

export interface FacePose {
  x: number;
  y: number;
  width: number;
  roll: number;
  visible: boolean;
}

const FOREHEAD = 10;
const LEFT_CHEEK = 234;
const RIGHT_CHEEK = 454;
const INFERENCE_INTERVAL_MS = 1000 / 15;
const SMOOTHING = 0.22;

const EMPTY_POSE: FacePose = {
  x: 0,
  y: 0.35,
  width: 0.35,
  roll: 0,
  visible: false,
};

export class FaceTracker {
  private readonly landmarker: FaceLandmarker;
  private pose: FacePose = { ...EMPTY_POSE };
  private lastInferenceAt = -Infinity;

  private constructor(landmarker: FaceLandmarker) {
    this.landmarker = landmarker;
  }

  static async create(): Promise<FaceTracker> {
    const vision = await FilesetResolver.forVisionTasks('/wasm');
    const options = {
      baseOptions: { modelAssetPath: '/models/face_landmarker.task' },
      runningMode: 'VIDEO',
      numFaces: 1,
      minFaceDetectionConfidence: 0.55,
      minFacePresenceConfidence: 0.55,
      minTrackingConfidence: 0.5,
    } as const;

    let landmarker: FaceLandmarker;
    try {
      landmarker = await FaceLandmarker.createFromOptions(vision, {
        ...options,
        baseOptions: { ...options.baseOptions, delegate: 'GPU' },
      });
    } catch {
      landmarker = await FaceLandmarker.createFromOptions(vision, options);
    }

    return new FaceTracker(landmarker);
  }

  update(video: HTMLVideoElement, now: number): FacePose {
    if (
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      now - this.lastInferenceAt < INFERENCE_INTERVAL_MS
    ) {
      return this.pose;
    }

    this.lastInferenceAt = now;
    const landmarks = this.landmarker.detectForVideo(video, now).faceLandmarks[0];

    if (!landmarks) {
      this.pose = { ...this.pose, visible: false };
      return this.pose;
    }

    const next = this.toPose(landmarks, video);
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
    this.landmarker.close();
  }

  private toPose(landmarks: NormalizedLandmark[], video: HTMLVideoElement): FacePose {
    const forehead = this.project(landmarks[FOREHEAD], video);
    const cheekA = this.project(landmarks[LEFT_CHEEK], video);
    const cheekB = this.project(landmarks[RIGHT_CHEEK], video);
    const [left, right] = cheekA.x < cheekB.x ? [cheekA, cheekB] : [cheekB, cheekA];
    const dx = right.x - left.x;
    const dy = right.y - left.y;
    const viewportAspect = window.innerWidth / Math.max(window.innerHeight, 1);

    return {
      x: forehead.x,
      y: forehead.y,
      width: Math.hypot(dx * viewportAspect, dy),
      roll: Math.atan2(dy, dx * viewportAspect),
      visible: true,
    };
  }

  private project(
    landmark: NormalizedLandmark,
    video: HTMLVideoElement,
  ): { x: number; y: number } {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const sourceWidth = video.videoWidth || viewportWidth;
    const sourceHeight = video.videoHeight || viewportHeight;
    const coverScale = Math.max(viewportWidth / sourceWidth, viewportHeight / sourceHeight);
    const displayedWidth = sourceWidth * coverScale;
    const displayedHeight = sourceHeight * coverScale;
    const cropX = (displayedWidth - viewportWidth) / 2;
    const cropY = (displayedHeight - viewportHeight) / 2;
    const pixelX = (1 - landmark.x) * displayedWidth - cropX;
    const pixelY = landmark.y * displayedHeight - cropY;

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
