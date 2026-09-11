"use client";

import { Html, Stars, useGLTF, useProgress } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DoubleSide,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
} from "three";

type SceneProps = {
  reducedMotion: boolean;
};

class ModelBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="scene-fallback" /> : this.props.children; }
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

function Universe({ reducedMotion }: SceneProps) {
  const group = useRef<Group>(null);
  const { scene } = useGLTF("/models/lunarveil-universe.glb");
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
          material.depthWrite = false;
          material.toneMapped = false;
          material.opacity = 1;
          if (material instanceof MeshStandardMaterial) {
            if (!material.emissiveMap && material.map) {
              material.emissiveMap = material.map;
            }
            material.emissive.set("#ffffff");
            material.emissiveIntensity = Math.max(material.emissiveIntensity, 1.35);
          }
          child.renderOrder = -100;
          child.frustumCulled = false;
          return material;
        });
        child.material = Array.isArray(child.material) ? materials : materials[0];
      }
    });
    return clone;
  }, [scene]);

  useFrame(({ clock }) => {
    if (!group.current) return;
    if (reducedMotion) {
      group.current.rotation.set(0, 1.27, 0);
      return;
    }

    const time = clock.getElapsedTime();
    group.current.rotation.y = 1.27 + time * 0.0018;
  });

  return (
    <group ref={group} position={[0, 0, 8]} scale={0.22} rotation={[0, 1.27, 0]}>
      <primitive object={model} />
    </group>
  );
}

function Moon({ reducedMotion }: SceneProps) {
  const group = useRef<Group>(null);
  const cursor = useRef({
    x: 0,
    y: 0,
  });
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

  useFrame(({ clock, pointer, size }, delta) => {
    if (!group.current) return;
    const mobile = size.width < 700;
    const x = mobile ? 0.2 : 1.9;
    group.current.scale.setScalar(mobile ? 0.032 : 0.041);
    if (reducedMotion) {
      cursor.current.x = 0;
      cursor.current.y = 0;
      group.current.rotation.set(0.08, -0.45, 0);
      group.current.position.set(x, mobile ? 0.75 : 0, 0);
      return;
    }

    const frameDelta = Math.min(delta, 0.05);
    const time = clock.getElapsedTime();

    cursor.current.x = MathUtils.damp(cursor.current.x, pointer.x, 7, frameDelta);
    cursor.current.y = MathUtils.damp(cursor.current.y, pointer.y, 7, frameDelta);

    // The moon stays fixed in space. Pointer input only changes its orientation
    // while the model continues its constant rotation around its own vertical axis.
    group.current.rotation.y = -0.45 + time * 0.045 + cursor.current.x * 0.16;
    group.current.rotation.x = MathUtils.damp(
      group.current.rotation.x,
      0.08 - cursor.current.y * 0.1,
      4,
      frameDelta,
    );
    group.current.rotation.z = 0;
    group.current.position.set(x, mobile ? 0.75 : 0, 0);
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

function Scene({ reducedMotion }: SceneProps) {
  return (
    <>
      <color attach="background" args={["#030408"]} />
      <ambientLight intensity={0.3} color="#9ca7c7" />
      <directionalLight position={[-4, 5, 6]} intensity={3.2} color="#fff5de" />
      <pointLight position={[4, -1, 4]} intensity={14} color="#718cff" distance={9} />
      <directionalLight position={[4, 2, -3]} intensity={2.1} color="#a8bcff" />
      <Suspense fallback={<Loader />}>
        <Universe reducedMotion={reducedMotion} />
        <Moon reducedMotion={reducedMotion} />
        <Stars
          radius={35}
          depth={18}
          count={reducedMotion ? 400 : 800}
          factor={1.6}
          saturation={0.05}
          fade
          speed={reducedMotion ? 0 : 0.08}
        />
      </Suspense>
    </>
  );
}

export function LunarScene({ reducedMotion }: SceneProps) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => { setVisible(entry.isIntersecting); });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="scene" ref={container} aria-hidden="true">
      <ModelBoundary>
      <Canvas
        frameloop={visible && !reducedMotion ? "always" : "demand"}
        camera={{ position: [0, 0, 8], fov: 42, near: 0.1, far: 120 }}
        dpr={[1, 1.35]}
        fallback={<div className="scene-fallback" />}
        gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
        onCreated={({ gl }) => {
          gl.toneMappingExposure = 1.25;
        }}
      >
        <Scene reducedMotion={reducedMotion} />
      </Canvas>
      </ModelBoundary>
    </div>
  );
}
