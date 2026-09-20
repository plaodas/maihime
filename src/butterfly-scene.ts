import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import butterflyUrl from '../butterfly.glb?url';
import type { FacePose } from './face-tracker';

type FlightState = 'waiting' | 'entering' | 'orbiting' | 'hovering' | 'exiting' | 'done';

const ENTER_DURATION = 2.6;
const ORBIT_DURATION = 6;
const HOVER_DURATION = 13;
const EXIT_DURATION = 2.8;

export class ButterflyScene {
  readonly renderer: THREE.WebGLRenderer;
  onComplete: (() => void) | undefined;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera();
  private readonly butterfly = new THREE.Group();
  private readonly clock = new THREE.Clock();
  private mixer: THREE.AnimationMixer | undefined;
  private state: FlightState = 'waiting';
  private stateStartedAt = 0;
  private elapsed = 0;
  private aspect = 1;
  private entryFromLeft = true;
  private completed = false;
  private hasHeading = false;
  private previousYaw = 0;
  private readonly anchor = new THREE.Vector2();
  private readonly target = new THREE.Vector3();
  private readonly previousPosition = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private readonly lookMatrix = new THREE.Matrix4();
  private readonly desiredQuaternion = new THREE.Quaternion();
  private readonly bankQuaternion = new THREE.Quaternion();
  private readonly bankAxis = new THREE.Vector3(0, 0, 1);

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(this.renderer.domElement);

    this.scene.add(new THREE.HemisphereLight(0xfff4d2, 0x29483b, 2.4));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(-2, 3, 4);
    this.scene.add(keyLight, this.butterfly);

    this.camera.position.z = 5;
    this.camera.near = 0.1;
    this.camera.far = 20;
    this.resize();
  }

  async load(): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(butterflyUrl);
    const model = gltf.scene;
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z);
    const normalization = maxDimension > 0 ? 1 / maxDimension : 1;

    model.position.copy(center).multiplyScalar(-normalization);
    model.scale.setScalar(normalization);
    // model.rotation.y = Math.PI;
    this.butterfly.add(model);
    this.butterfly.visible = false;

    if (gltf.animations.length > 0) {
      this.mixer = new THREE.AnimationMixer(model);
      const preferred =
        gltf.animations.find((clip) => clip.name === 'アーマチュアアクション') ??
        gltf.animations[0];
      this.mixer.clipAction(preferred).play();
    }
  }

  restart(): void {
    this.state = 'waiting';
    this.stateStartedAt = this.elapsed;
    this.entryFromLeft = Math.random() > 0.5;
    this.completed = false;
    this.hasHeading = false;
    this.previousYaw = 0;
    this.butterfly.visible = false;
  }

  update(pose: FacePose): void {
    const delta = Math.min(this.clock.getDelta(), 0.05);
    this.elapsed += delta;
    this.mixer?.update(delta);

    if (pose.visible || this.state !== 'waiting') {
      this.updateAnchor(pose);
      this.updateFlight(pose);
    }

    this.renderer.render(this.scene, this.camera);
  }

  resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.aspect = width / Math.max(height, 1);
    this.camera.left = -this.aspect;
    this.camera.right = this.aspect;
    this.camera.top = 1;
    this.camera.bottom = -1;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private updateAnchor(pose: FacePose): void {
    if (!pose.visible && this.state !== 'waiting') return;
    const targetX = pose.x * this.aspect;
    const targetY = pose.y + Math.min(pose.width * 0.18, 0.12);
    const follow = this.state === 'entering' ? 0.035 : 0.1;
    this.anchor.x += (targetX - this.anchor.x) * follow;
    this.anchor.y += (targetY - this.anchor.y) * follow;
  }

  private updateFlight(pose: FacePose): void {
    if (this.state === 'waiting') {
      this.anchor.set(pose.x * this.aspect, pose.y);
      this.transition('entering');
      this.butterfly.visible = true;
    }

    const progress = this.elapsed - this.stateStartedAt;
    const faceWidth = THREE.MathUtils.clamp(pose.width, 0.26, 0.85);
    const scale = THREE.MathUtils.clamp(faceWidth * 0.42, 0.14, 0.38);
    const flutter = Math.sin(this.elapsed * 3.1);

    switch (this.state) {
      case 'entering': {
        const t = this.easeOutCubic(Math.min(progress / ENTER_DURATION, 1));
        const startX = (this.entryFromLeft ? -1 : 1) * (this.aspect + 0.5);
        const endX = this.anchor.x - faceWidth * 0.7;
        this.target.set(
          THREE.MathUtils.lerp(startX, endX, t),
          THREE.MathUtils.lerp(this.anchor.y + 0.25, this.anchor.y + 0.02, t) +
            Math.sin(t * Math.PI * 3) * 0.08,
          0,
        );
        if (progress >= ENTER_DURATION) this.transition('orbiting');
        break;
      }
      case 'orbiting': {
        const t = Math.min(progress / ORBIT_DURATION, 1);
        const angle = t * Math.PI * 3.6 + (this.entryFromLeft ? Math.PI : 0);
        this.target.set(
          this.anchor.x + Math.cos(angle) * faceWidth * 0.78,
          this.anchor.y - 0.12 + Math.sin(angle) * faceWidth * 0.5,
          Math.sin(angle * 0.5) * 0.25,
        );
        if (progress >= ORBIT_DURATION) this.transition('hovering');
        break;
      }
      case 'hovering': {
        this.target.set(
          this.anchor.x + faceWidth * 0.64 + Math.sin(this.elapsed * 1.7) * 0.045,
          this.anchor.y + flutter * 0.035 + Math.sin(this.elapsed * 0.73) * 0.02,
          Math.sin(this.elapsed * 0.9) * 0.08,
        );
        if (progress >= HOVER_DURATION) this.transition('exiting');
        break;
      }
      case 'exiting': {
        const t = this.easeInCubic(Math.min(progress / EXIT_DURATION, 1));
        const startX = this.anchor.x + faceWidth * 0.64;
        const endX = (this.entryFromLeft ? 1 : -1) * (this.aspect + 0.6);
        this.target.set(
          THREE.MathUtils.lerp(startX, endX, t),
          this.anchor.y + t * 0.45 + Math.sin(t * Math.PI * 2) * 0.06,
          -t * 0.5,
        );
        if (progress >= EXIT_DURATION) this.finish();
        break;
      }
      case 'done':
      case 'waiting':
        return;
    }

    if (this.hasHeading) {
      this.velocity.subVectors(this.target, this.previousPosition);
    } else {
      this.velocity.set(this.entryFromLeft ? 1 : -1, 0.08, 0);
    }
    this.previousPosition.copy(this.target);

    this.butterfly.position.copy(this.target);
    this.butterfly.scale.setScalar(scale * (1 + flutter * 0.025));
    this.orientToVelocity();
  }

  private orientToVelocity(): void {
    if (this.velocity.lengthSq() < 1e-8) return;

    this.lookTarget.copy(this.butterfly.position).add(this.velocity);
    this.lookMatrix.lookAt(this.lookTarget, this.butterfly.position, this.worldUp);
    this.desiredQuaternion.setFromRotationMatrix(this.lookMatrix);

    const yaw = Math.atan2(this.velocity.x, -this.velocity.z);
    const yawDelta = Math.atan2(Math.sin(yaw - this.previousYaw), Math.cos(yaw - this.previousYaw));
    this.previousYaw = yaw;
    const bank = THREE.MathUtils.clamp(-yawDelta * 10, -0.55, 0.55);
    this.bankQuaternion.setFromAxisAngle(this.bankAxis, bank);
    this.desiredQuaternion.multiply(this.bankQuaternion);

    if (!this.hasHeading) {
      this.butterfly.quaternion.copy(this.desiredQuaternion);
      this.hasHeading = true;
      return;
    }

    const follow = this.state === 'hovering' ? 0.1 : 0.2;
    this.butterfly.quaternion.slerp(this.desiredQuaternion, follow);
  }

  private transition(next: FlightState): void {
    this.state = next;
    this.stateStartedAt = this.elapsed;
  }

  private finish(): void {
    this.state = 'done';
    this.butterfly.visible = false;
    if (!this.completed) {
      this.completed = true;
      this.onComplete?.();
    }
  }

  private easeOutCubic(value: number): number {
    return 1 - (1 - value) ** 3;
  }

  private easeInCubic(value: number): number {
    return value ** 3;
  }
}
