"use client";

import React, { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment } from "@react-three/drei";
import * as THREE from "three";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { AgentState } from "@livekit/components-react";

/**
 * SMJAR 品牌标识动画：线框地球。
 *
 * 取自品牌 logo 中的绿色线框地球（见 public/static/brand/README）：
 * 实心地球 + 经纬网格。行为沿用原可视化组件——旋转、上下浮动、随音量缩放与发光；
 * 未连接时转为品牌深绿并沉下去表示待机（不退成灰色，以保住品牌辨识度）。
 */

// 品牌色（见 public/static/brand/README）
const BRAND_GREEN = "#1F7A3C";
const BRAND_GREEN_LIGHT = "#58B96C";
const BRAND_GREEN_DARK = "#0A3A1B";

const Globe: React.FC<{
  volume: number;
  state: AgentState;
}> = ({ volume, state }) => {
  const groupRef = useRef<THREE.Group>(null);
  const globeRef = useRef<THREE.Mesh>(null);

  const emissiveColor = useRef(new THREE.Color(BRAND_GREEN));
  const targetColor = useRef(new THREE.Color(BRAND_GREEN));
  const isDisconnected = state === "disconnected";

  // 未连接时不退成灰色——用品牌深绿表示「待机」，既读得出未开始，又保住品牌辨识度
  const disconnectedColor = BRAND_GREEN_DARK;

  // 几何体只建一次，避免每帧重建
  const globeGeometry = useMemo(() => new THREE.SphereGeometry(1, 48, 48), []);
  const gridGeometry = useMemo(
    () => new THREE.SphereGeometry(1.005, 24, 16),
    []
  );

  useFrame((frameState) => {
    const group = groupRef.current;
    if (!group) return;

    // 地球绕自转轴转；断开时转快一点，像在待机
    group.rotation.y += isDisconnected ? 0.05 : 0.025;
    group.rotation.x = isDisconnected ? -0.15 : -0.08;

    if (isDisconnected) {
      group.position.y = THREE.MathUtils.lerp(group.position.y, -1, 0.1);
    } else {
      const t = frameState.clock.getElapsedTime();
      group.position.y = THREE.MathUtils.lerp(
        group.position.y,
        Math.sin(t * 3) * 0.1,
        0.1
      );
    }

    const scale = THREE.MathUtils.lerp(group.scale.x, 1 + volume * 0.5, 0.2);
    group.scale.setScalar(scale);

    targetColor.current.set(isDisconnected ? disconnectedColor : BRAND_GREEN);
    emissiveColor.current.lerp(targetColor.current, 0.1);

    if (globeRef.current) {
      const material = globeRef.current.material as THREE.MeshStandardMaterial;
      material.emissive = emissiveColor.current;
      material.emissiveIntensity = isDisconnected
        ? 0.6
        : volume > 0
        ? 2.5
        : 0.35;
    }
  });

  const globeMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: isDisconnected ? disconnectedColor : BRAND_GREEN,
        roughness: isDisconnected ? 0.85 : 0.5,
        metalness: isDisconnected ? 0.2 : 0.4,
        emissive: emissiveColor.current,
        emissiveIntensity: 0.35,
      }),
    [isDisconnected, disconnectedColor]
  );

  // 经纬线始终用浅绿：地球线框是品牌的辨识特征，待机时也必须看得出来，
  // 只靠降低不透明度来表示「未开始」，不换成低对比度的颜色。
  const gridMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: BRAND_GREEN_LIGHT,
        wireframe: true,
        transparent: true,
        opacity: isDisconnected ? 0.6 : 0.8,
      }),
    [isDisconnected]
  );

  return (
    <group ref={groupRef}>
      <mesh ref={globeRef} geometry={globeGeometry} material={globeMaterial} />
      {/* 经纬网格，对应 logo 里的地球线框 */}
      <mesh geometry={gridGeometry} material={gridMaterial} />
    </group>
  );
};

export const SmjarMark = ({
  volume,
  state,
}: {
  volume: number;
  state: AgentState;
}) => {
  return (
    <Canvas camera={{ position: [0, 0, 5], fov: 60 }}>
      <ambientLight intensity={1.2} />
      <pointLight position={[2, 1, 3]} intensity={6} />
      <Globe volume={volume} state={state} />
      <Environment preset="night" background={false} />
      <EffectComposer>
        <Bloom
          intensity={state === "disconnected" ? 0.4 : volume > 0 ? 1.6 : 0.15}
          radius={50}
          luminanceThreshold={0.0}
          luminanceSmoothing={1}
        />
      </EffectComposer>
    </Canvas>
  );
};
