"use client";

import { Html, useGLTF, useProgress } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DoubleSide,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
} from "three";
import { moonCursorSpin, moonTravelPosition, spaceTravelPose } from "./spaceJourney";

type SceneProps = {
  reducedMotion: boolean;
  travelProgress?: { readonly current: number };
};

class ModelBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function Loader() {
  const { progress } = useProgress();

  return (
    <Html center>
      <div className="model-loader" role="status">
        <span>{Math.round(progress)}</span>
        <small>mapping the veil</small>
      </div>
    </Html>
  );
}

function Universe({ reducedMotion, travelProgress }: SceneProps) {
  const group = useRef<Group>(null);
  const drift = useRef(0);
  const gl = useThree(state => state.gl);
  const supportsHd = gl.capabilities.maxTextureSize >= 8192;
  const { scene } = useGLTF(supportsHd
    ? "/models/lunarveil-universe-hd.glb"
    : "/models/lunarveil-universe.glb");
  const model = useMemo(() => {
    const clone = scene.clone(true);
    clone.traverse(child => {
      if (!(child instanceof Mesh)) return;
      const sources = Array.isArray(child.material) ? child.material : [child.material];
      const materials = sources.map(source => {
        const texture = source instanceof MeshStandardMaterial
          ? source.emissiveMap ?? source.map
          : source instanceof MeshBasicMaterial ? source.map : null;
        if (texture) {
          texture.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
          texture.needsUpdate = true;
        }
        // The sky is self-lit: moon lighting must not wash it out or hide it.
        return new MeshBasicMaterial({
          map: texture,
          color: texture ? "#ffffff" : "#030408",
          side: DoubleSide,
          depthWrite: false,
          depthTest: false,
          toneMapped: false,
        });
      });
      child.material = Array.isArray(child.material) ? materials : materials[0];
      child.renderOrder = -100;
      child.frustumCulled = false;
    });
    return clone;
  }, [scene, gl]);
  useEffect(() => () => {
    model.traverse(child => {
      if (child instanceof Mesh) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach(material => material.dispose());
      }
    });
  }, [model]);
  useFrame((_state, delta) => {
    if (!group.current) return;
    const step = Math.min(delta, 0.05);
    if (!reducedMotion) drift.current += step * 0.008;
    const pose = spaceTravelPose(travelProgress?.current ?? 0, drift.current, reducedMotion);
    if (reducedMotion) {
      group.current.rotation.set(pose.pitch, pose.yaw, pose.roll);
      return;
    }
    group.current.rotation.x = MathUtils.damp(group.current.rotation.x, pose.pitch, 3, step);
    group.current.rotation.y = MathUtils.damp(group.current.rotation.y, pose.yaw, 3, step);
    group.current.rotation.z = MathUtils.damp(group.current.rotation.z, pose.roll, 3, step);
  });
  // Preserve the original sky scale and camera position. Never zoom on scroll.
  return <group ref={group} position={[0, 0, 8]} scale={0.22} rotation={[0, 1.27, 0]}>
    <primitive object={model} />
  </group>;
}

function Moon({ reducedMotion, travelProgress }: SceneProps) {
  const group = useRef<Group>(null);
  const cursor = useRef({
    horizontal: 0,
    spin: 0,
  });
  useEffect(() => {
    if (reducedMotion) return;
    const reset = () => { cursor.current.horizontal = 0; };
    // Listen without capturing the canvas: all page links remain clickable.
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") { reset(); return; }
      cursor.current.horizontal = event.clientX / Math.max(1, window.innerWidth) * 2 - 1;
    };
    const leave = (event: PointerEvent) => { if (event.relatedTarget === null) reset(); };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerout", leave, { passive: true });
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerout", leave);
      window.removeEventListener("blur", reset);
      reset();
    };
  }, [reducedMotion]);
  const { scene } = useGLTF("/models/lunarveil-moon.glb");
  const model = useMemo(() => {
    const clone = scene.clone(true);
    clone.traverse((child) => {
      if (child instanceof Mesh) {
        const sourceMaterials = Array.isArray(child.material)
          ? child.material
          : [child.material];
        const materials = sourceMaterials.map((source) => {
          const material = source.clone();
          material.side = DoubleSide;
          if (material instanceof MeshStandardMaterial) {
            material.roughness = Math.max(material.roughness, 0.82);
          }
          return material;
        });
        child.material = Array.isArray(child.material) ? materials : materials[0];
      }
    });
    return clone;
  }, [scene]);

  useFrame(({ clock, size }, delta) => {
    if (!group.current) return;
    const mobile = size.width < 700;
    const position = moonTravelPosition(travelProgress?.current ?? 0, mobile, reducedMotion);
    group.current.scale.setScalar(mobile ? 0.032 : 0.041);
    if (reducedMotion) {
      cursor.current.horizontal = 0;
      cursor.current.spin = 0;
      group.current.rotation.set(0.08, -0.45, 0);
      group.current.position.set(position.x, position.y, position.z);
      return;
    }

    const frameDelta = Math.min(delta, 0.05);
    const time = clock.getElapsedTime();

    const targetSpin = moonCursorSpin(cursor.current.horizontal, travelProgress?.current ?? 0, reducedMotion);
    cursor.current.spin = MathUtils.damp(cursor.current.spin, targetSpin, 7, frameDelta);

    // Cursor input spins the moon around its own axis, never tilts or moves it.
    // Camera distance and model scale stay unchanged throughout the journey.
    group.current.rotation.y = -0.45 + time * 0.045 + cursor.current.spin;
    group.current.rotation.x = 0.08;
    group.current.rotation.z = 0;
    group.current.position.x = MathUtils.damp(group.current.position.x, position.x, 4, frameDelta);
    group.current.position.y = MathUtils.damp(group.current.position.y, position.y, 4, frameDelta);
    group.current.position.z = position.z;
  });

  return (
    <group
      ref={group}
      position={[1.9, 0, 0]}
      rotation={[0.08, -0.45, 0]}
      scale={0.041}
    >
      <primitive object={model} />
    </group>
  );
}

function Scene({ reducedMotion, travelProgress }: SceneProps) {
  return (
    <>
      <ambientLight intensity={0.3} color="#9ca7c7" />
      <directionalLight position={[-4, 5, 6]} intensity={3.2} color="#fff5de" />
      <pointLight position={[4, -1, 4]} intensity={14} color="#718cff" distance={9} />
      <directionalLight position={[4, 2, -3]} intensity={2.1} color="#a8bcff" />
      <Suspense fallback={<Loader />}>
        <Moon reducedMotion={reducedMotion} travelProgress={travelProgress} />
      </Suspense>
    </>
  );
}

function SceneCanvas({ reducedMotion, travelProgress, background = false }: SceneProps & { background?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => { setVisible(entry.isIntersecting); });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div className={background ? "story-space-background" : "scene"} ref={container} aria-hidden="true">
      <ModelBoundary fallback={<div className={background ? "space-fallback" : "scene-fallback"} />}>
      <Canvas
        frameloop={visible && !reducedMotion ? "always" : "demand"}
        camera={{ position: [0, 0, 8], fov: 42, near: 0.1, far: 120 }}
        dpr={[1, 2]}
        fallback={<div className={background ? "space-fallback" : "scene-fallback"} />}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        onCreated={({ gl }) => {
          gl.toneMappingExposure = 1.25;
          gl.setClearColor(0x000000, 0);
        }}
      >
        {background
          ? <Suspense fallback={null}><Universe reducedMotion={reducedMotion} travelProgress={travelProgress} /></Suspense>
          : <Scene reducedMotion={reducedMotion} travelProgress={travelProgress} />}
      </Canvas>
      </ModelBoundary>
    </div>
  );
}

export function LunarScene(props: SceneProps) {
  return <SceneCanvas {...props} />;
}

export function LunarBackground(props: SceneProps) {
  return <SceneCanvas {...props} background />;
}
