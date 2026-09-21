import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import butterflyUrl from '../butterfly.glb?url';
import { isMobileDevice } from './device';
import type { FacePose } from './face-tracker';

type FlightState = 'waiting' | 'entering' | 'orbiting' | 'hovering' | 'exiting' | 'done';

const ENTER_DURATION = 5;
const ORBIT_DURATION = 9;
const HOVER_DURATION = 6;
const EXIT_DURATION = 2.8;
const PARTICLE_COUNT = Math.round(140 * (isMobileDevice() ? 0.3 : 1));
const PARTICLE_LIFE_SCALE = isMobileDevice() ? 0.5 : 1;

export class ButterflyScene {
  readonly renderer: THREE.WebGLRenderer;
  onComplete: (() => void) | undefined;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera();
  private readonly butterfly = new THREE.Group();
  private readonly flower = new THREE.Sprite();
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
  private readonly particles: THREE.Points;
  private readonly particlePositions: Float32Array;
  private readonly particleColors: Float32Array;
  private readonly particleStates = Array.from({ length: PARTICLE_COUNT }, () => ({
    age: 0,
    life: 1.6,
    phase: 0,
    radius: 0.02,
    speed: 0.12,
    spin: 2.4,
    hue: 0,
    side: 1,
    originX: 0,
    originY: 0,
    originZ: 0,
    hasOrigin: false,
  }));
  private particleTexture: THREE.CanvasTexture | undefined;
  private flowerTexture: THREE.Texture | undefined;
  private readonly whiteColor = new THREE.Color('#ffffff');
  private readonly mistColor = new THREE.Color('#f4f7ff');
  private readonly particleColor = new THREE.Color();
  private readonly wingWorld = new THREE.Vector3();

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: !isMobileDevice(),
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobileDevice() ? 1.25 : 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(this.renderer.domElement);

    this.scene.add(new THREE.HemisphereLight(0xfff4d2, 0x29483b, 2.4));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(-2, 3, 4);
    this.scene.add(keyLight, this.butterfly, this.flower);
    this.flower.visible = false;
    this.flower.material.transparent = true;
    this.flower.material.depthWrite = false;
    this.flower.material.alphaTest = 0.12;
    this.flower.material.opacity = 0;
    this.particles = this.createParticles();
    this.particlePositions = this.particles.geometry.attributes.position.array as Float32Array;
    this.particleColors = this.particles.geometry.attributes.color.array as Float32Array;
    this.scene.add(this.particles);

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
    this.butterfly.add(model);
    this.butterfly.visible = false;
    await this.loadFlower();

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
    this.flower.visible = false;
    this.flower.material.opacity = 0;
    this.resetParticles();
  }

  update(pose: FacePose): void {
    const delta = Math.min(this.clock.getDelta(), 0.05);
    this.elapsed += delta;
    this.mixer?.update(delta);

    if (pose.visible || this.state !== 'waiting') {
      this.updateAnchor(pose);
      this.updateFlower(pose);
      this.updateFlight(pose);
    }
    this.updateParticles(delta);

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
    this.particles.geometry.dispose();
    const particleMaterial = this.particles.material;
    if (particleMaterial instanceof THREE.Material) particleMaterial.dispose();
    this.particleTexture?.dispose();
    this.flowerTexture?.dispose();
    this.flower.material.dispose();
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
    const targetY = pose.y + Math.min(pose.width * 0.1, 0.07);
    const follow = pose.visible ? 0.45 : 0.12;
    this.anchor.x += (targetX - this.anchor.x) * follow;
    this.anchor.y += (targetY - this.anchor.y) * follow;
  }

  private async loadFlower(): Promise<void> {
    this.flowerTexture = await new THREE.TextureLoader().loadAsync('/flower.png');
    this.flowerTexture.colorSpace = THREE.SRGBColorSpace;
    this.flower.material.dispose();
    this.flower.material = new THREE.SpriteMaterial({
      map: this.flowerTexture,
      color: 0xffffff,
      transparent: true,
      alphaTest: 0.2,
      depthWrite: false,
      opacity: 0,
    });
  }

  private updateFlower(pose: FacePose): void {
    const flying = this.state !== 'waiting' && this.state !== 'done';
    const show = flying && pose.visible;
    this.flower.visible = flying;
    const material = this.flower.material;
    material.opacity += ((show ? 1 : 0) - material.opacity) * 0.18;
    if (material.opacity < 0.02 && !show) {
      this.flower.visible = false;
      return;
    }

    const faceWidth = THREE.MathUtils.clamp(pose.width, 0.26, 0.85);
    this.flower.position.set(this.anchor.x, this.anchor.y, 0.02);
    this.flower.scale.setScalar(THREE.MathUtils.clamp(faceWidth * 0.22, 0.08, 0.16));
    material.rotation = pose.roll * 0.55;
  }

  private updateFlight(pose: FacePose): void {
    if (this.state === 'waiting') {
      this.anchor.set(pose.x * this.aspect, pose.y + Math.min(pose.width * 0.1, 0.07));
      this.transition('entering');
      this.butterfly.visible = true;
    }

    const progress = this.elapsed - this.stateStartedAt;
    const faceWidth = THREE.MathUtils.clamp(pose.width, 0.56, 1.25);
    const scale = THREE.MathUtils.clamp(faceWidth * 0.16, 0.12, 0.32);
    const flutter = Math.sin(this.elapsed * 3.1);
    const orbitRadius = faceWidth * 0.34;

    switch (this.state) {
      case 'entering': {
        const t = this.easeOutCubic(Math.min(progress / ENTER_DURATION, 1));
        const startX = (this.entryFromLeft ? -1 : 1) * (this.aspect + 0.5);
        const side = this.entryFromLeft ? -1 : 1;
        this.target.set(
          THREE.MathUtils.lerp(startX, this.anchor.x + side * orbitRadius, t),
          THREE.MathUtils.lerp(this.anchor.y + 0.2, this.anchor.y + 0.04, t) +
            Math.sin(t * Math.PI * 3) * 0.05,
          0,
        );
        if (progress >= ENTER_DURATION) this.transition('orbiting');
        break;
      }
      case 'orbiting': {
        const t = Math.min(progress / ORBIT_DURATION, 1);
        const angle = t * Math.PI * 4.2 + (this.entryFromLeft ? Math.PI : 0);
        this.target.set(
          this.anchor.x + Math.cos(angle) * orbitRadius,
          this.anchor.y + Math.sin(angle) * orbitRadius * 0.72,
          Math.sin(angle * 0.5) * 0.12,
        );
        if (progress >= ORBIT_DURATION) this.transition('hovering');
        break;
      }
      case 'hovering': {
        this.target.set(
          this.anchor.x + orbitRadius * 0.55 + Math.sin(this.elapsed * 1.7) * 0.03,
          this.anchor.y + 0.05 + flutter * 0.028 + Math.sin(this.elapsed * 0.73) * 0.016,
          Math.sin(this.elapsed * 0.9) * 0.06,
        );
        if (progress >= HOVER_DURATION) this.transition('exiting');
        break;
      }
      case 'exiting': {
        const t = this.easeInCubic(Math.min(progress / EXIT_DURATION, 1));
        const startX = this.anchor.x + orbitRadius * 0.55;
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

  private createParticles(): THREE.Points {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const colors = new Float32Array(PARTICLE_COUNT * 3);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.particleTexture = this.createParticleTexture();
    const material = new THREE.PointsMaterial({
      map: this.particleTexture,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      size: 4.6,
      sizeAttenuation: false,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.visible = false;
    this.resetParticles();
    return points;
  }

  private createParticleTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    if (!context) return new THREE.CanvasTexture(canvas);

    const gradient = context.createRadialGradient(32, 32, 1, 32, 32, 16);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.45, 'rgba(255, 255, 255, 0.7)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private resetParticles(): void {
    this.particleStates.forEach((particle, index) => {
      this.seedParticle(particle, true, index);
    });
  }

  private seedParticle(
    particle: (typeof this.particleStates)[number],
    stagger: boolean,
    index = 0,
  ): void {
    particle.life = (1.2 + Math.random() * 1.1) * PARTICLE_LIFE_SCALE;
    particle.age = stagger ? (index / PARTICLE_COUNT) * particle.life : 0;
    particle.phase = Math.random() * Math.PI * 2;
    particle.radius = 0.01 + Math.random() * 0.018;
    particle.speed = 0.07 + Math.random() * 0.06;
    particle.spin = (Math.random() > 0.5 ? 1 : -1) * (2.2 + Math.random() * 2.6);
    particle.hue = Math.random();
    particle.side = Math.random() > 0.5 ? -1 : 1;
    if (this.butterfly.visible) {
      this.captureWingOrigin(particle);
    } else {
      particle.hasOrigin = false;
    }
  }

  private captureWingOrigin(particle: (typeof this.particleStates)[number]): void {
    this.butterfly.updateMatrixWorld();
    this.wingWorld.set(
      particle.side * (0.3 + Math.random() * 0.16),
      -0.14 - Math.random() * 0.1,
      (Math.random() - 0.5) * 0.08,
    );
    this.butterfly.localToWorld(this.wingWorld);
    particle.originX = this.wingWorld.x;
    particle.originY = this.wingWorld.y;
    particle.originZ = this.wingWorld.z;
    particle.hasOrigin = true;
  }

  private updateParticles(delta: number): void {
    const flying = this.state !== 'waiting' && this.state !== 'done';
    this.particles.visible =
      flying || this.particleStates.some((particle) => particle.age < particle.life);

    if (!this.particles.visible) return;

    this.particleStates.forEach((particle, index) => {
      particle.age += delta;
      if (particle.age >= particle.life) {
        if (!flying) {
          this.particleColors[index * 3] = 0;
          this.particleColors[index * 3 + 1] = 0;
          this.particleColors[index * 3 + 2] = 0;
          return;
        }
        this.seedParticle(particle, false);
      }

      if (flying && this.butterfly.visible && !particle.hasOrigin) {
        this.captureWingOrigin(particle);
      }

      const t = THREE.MathUtils.clamp(particle.age / particle.life, 0, 1);
      const fade = t < 0.08 ? t / 0.08 : t > 0.72 ? (1 - t) / 0.28 : 1;
      const angle = particle.phase + particle.age * particle.spin;
      const spiral = particle.radius * t * (1.2 + t);
      const i = index * 3;
      this.particlePositions[i] = particle.originX + Math.cos(angle) * spiral;
      this.particlePositions[i + 1] = particle.originY - particle.age * particle.speed;
      this.particlePositions[i + 2] = particle.originZ + Math.sin(angle) * spiral * 0.6;

      this.particleColor.copy(this.whiteColor).lerp(this.mistColor, particle.hue);
      const brightness = fade * (flying ? 0.8 : 0.28);
      this.particleColors[i] = this.particleColor.r * brightness;
      this.particleColors[i + 1] = this.particleColor.g * brightness;
      this.particleColors[i + 2] = this.particleColor.b * brightness;
    });

    this.particles.geometry.attributes.position.needsUpdate = true;
    this.particles.geometry.attributes.color.needsUpdate = true;
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
    this.flower.visible = false;
    this.flower.material.opacity = 0;
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
