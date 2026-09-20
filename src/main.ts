import './style.css';
import { ButterflyScene } from './butterfly-scene';
import { isMobileDevice } from './device';
import { FaceTracker } from './face-tracker';

const requireElement = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Required element not found: ${selector}`);
  return element;
};

const welcome = requireElement<HTMLElement>('#welcome');
const experience = requireElement<HTMLElement>('#experience');
const errorPanel = requireElement<HTMLElement>('#error-panel');
const camera = requireElement<HTMLVideoElement>('#camera');
const sceneHost = requireElement<HTMLElement>('#scene');
const status = requireElement<HTMLElement>('#status');
const result = requireElement<HTMLElement>('#result');
const errorTitle = requireElement<HTMLElement>('#error-title');
const errorMessage = requireElement<HTMLElement>('#error-message');
const startButton = requireElement<HTMLButtonElement>('#start-button');
const stopButton = requireElement<HTMLButtonElement>('#stop-button');
const replayButton = requireElement<HTMLButtonElement>('#replay-button');
const retryButton = requireElement<HTMLButtonElement>('#retry-button');

let stream: MediaStream | undefined;
let tracker: FaceTracker | undefined;
let butterflyScene: ButterflyScene | undefined;
let animationFrame = 0;
let starting = false;
let running = false;
let lastStatus = '';
let trackingFailed = false;
let sessionId = 0;

startButton.addEventListener('click', () => void startSession());
retryButton.addEventListener('click', () => void startSession());
stopButton.addEventListener('click', () => stopSession(true));
replayButton.addEventListener('click', () => {
  result.hidden = true;
  setStatus('顔を画面の中央に合わせてください');
  butterflyScene?.restart();
});

window.addEventListener('resize', () => butterflyScene?.resize());
window.addEventListener('orientationchange', () => {
  window.setTimeout(() => butterflyScene?.resize(), 150);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && (running || starting)) {
    stopSession(true);
  }
});
window.addEventListener('pagehide', () => stopSession(true));

async function startSession(): Promise<void> {
  if (starting || running) return;

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showError(
      'このブラウザではカメラを起動できません',
      'HTTPSで開き、カメラを利用できるスマートフォンのブラウザでお試しください。',
    );
    return;
  }

  starting = true;
  trackingFailed = false;
  startButton.disabled = true;
  retryButton.disabled = true;
  const currentSession = ++sessionId;
  showExperience();
  setStatus('カメラと蝶を準備しています…');

  try {
    const scene = new ButterflyScene(sceneHost);
    butterflyScene = scene;
    scene.onComplete = () => {
      result.hidden = false;
      setStatus('ひと休み、おつかれさまでした');
    };

    stream = await openCamera();
    await widenCamera(stream);

    if (currentSession !== sessionId) {
      stream.getTracks().forEach((track) => track.stop());
      stream = undefined;
      return;
    }

    camera.srcObject = stream;
    await camera.play();
    const faceTracker = await FaceTracker.create();
    if (currentSession !== sessionId) {
      faceTracker.close();
      return;
    }
    tracker = faceTracker;
    await scene.load();
    if (currentSession !== sessionId) {
      scene.dispose();
      return;
    }

    running = true;
    setStatus('顔を画面の中央に合わせてください');
    animationFrame = requestAnimationFrame(renderFrame);
  } catch (error) {
    if (currentSession !== sessionId) return;
    stopSession(false);
    const message = describeError(error);
    showError(message.title, message.detail);
  } finally {
    starting = false;
    startButton.disabled = false;
    retryButton.disabled = false;
  }
}

function renderFrame(now: number): void {
  if (!running || !tracker || !butterflyScene) return;

  try {
    const pose = tracker.update(camera, now);
    butterflyScene.update(pose);

    if (!result.hidden) {
      // Completion status takes priority.
    } else if (pose.visible) {
      setStatus('蝶(オグラムラサキ)がやってきました');
    } else {
      setStatus('顔を画面の中央に合わせてください');
    }
  } catch (error) {
    if (!trackingFailed) {
      trackingFailed = true;
      stopSession(false);
      const message = describeError(error);
      showError('顔認識を続けられませんでした', message.detail);
    }
    return;
  }

  animationFrame = requestAnimationFrame(renderFrame);
}

function stopSession(showWelcome: boolean): void {
  sessionId += 1;
  running = false;
  starting = false;
  cancelAnimationFrame(animationFrame);
  animationFrame = 0;

  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  camera.pause();
  camera.srcObject = null;

  tracker?.close();
  tracker = undefined;
  butterflyScene?.dispose();
  butterflyScene = undefined;
  sceneHost.replaceChildren();
  result.hidden = true;

  if (showWelcome) {
    errorPanel.hidden = true;
    experience.hidden = true;
    welcome.hidden = false;
  }
}

function showExperience(): void {
  welcome.hidden = true;
  errorPanel.hidden = true;
  experience.hidden = false;
  result.hidden = true;
}

function showError(title: string, detail: string): void {
  welcome.hidden = true;
  experience.hidden = true;
  errorPanel.hidden = false;
  errorTitle.textContent = title;
  errorMessage.textContent = detail;
}

function setStatus(message: string): void {
  if (message === lastStatus) return;
  lastStatus = message;
  status.textContent = message;
}

async function openCamera(): Promise<MediaStream> {
  const facing = { facingMode: { ideal: 'user' as const } };
  if (!isMobileDevice()) {
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { ...facing, frameRate: { ideal: 30, max: 30 } },
    });
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...facing,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 24, max: 30 },
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'OverconstrainedError') {
      return navigator.mediaDevices.getUserMedia({ audio: false, video: facing });
    }
    throw error;
  }
}

async function widenCamera(mediaStream: MediaStream): Promise<void> {
  const track = mediaStream.getVideoTracks()[0];
  if (!track?.getCapabilities) return;

  const capabilities = track.getCapabilities() as MediaTrackCapabilities & {
    zoom?: { min?: number };
  };
  const zoom = capabilities.zoom;
  if (!zoom) return;

  try {
    await track.applyConstraints({
      advanced: [{ zoom: zoom.min ?? 1 } as MediaTrackConstraintSet],
    });
  } catch {
    try {
      await track.applyConstraints({ zoom: zoom.min ?? 1 } as MediaTrackConstraintSet);
    } catch {
      // Some browsers advertise zoom but reject applying it.
    }
  }
}

function describeError(error: unknown): { title: string; detail: string } {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return {
        title: 'カメラの許可が必要です',
        detail:
          'ブラウザの設定でこのサイトのカメラ利用を許可してから、もう一度お試しください。',
      };
    }
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
      return {
        title: '正面カメラが見つかりません',
        detail: 'カメラを利用できる端末か確認して、もう一度お試しください。',
      };
    }
    if (error.name === 'NotReadableError') {
      return {
        title: 'カメラを使用できません',
        detail: 'ほかのアプリがカメラを使用していないか確認してください。',
      };
    }
  }

  console.error(error);
  return {
    title: '準備中に問題が起きました',
    detail: '通信状態を確認してページを再読み込みしてください。',
  };
}

