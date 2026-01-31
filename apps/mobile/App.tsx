import React, { useEffect, useMemo, useRef, useState } from "react";
import { Text, View, Button, StyleSheet, Dimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { nanoid } from "nanoid/non-secure";
import Svg, { Polyline } from "react-native-svg";
import { MsgTypes, WS_VERSION, type Point, type StrokeMsg } from "@inlko/shared";

const REALTIME_URL = "ws://172.20.10.3:8080";

type Screen = "scan" | "draw";

export default function App() {
  const [screen, setScreen] = useState<Screen>("scan");
  const [permission, requestPermission] = useCameraPermissions();

  const [roomId, setRoomId] = useState<string>("");
  const [pairToken, setPairToken] = useState<string>("");
  const [paired, setPaired] = useState(false);

  const [localPoints, setLocalPoints] = useState<Point[]>([]);
  const [activeStrokeId, setActiveStrokeId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!permission) requestPermission();
  }, [permission, requestPermission]);

  useEffect(() => {
    const ws = new WebSocket(`${REALTIME_URL}?role=mobile`);
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type === MsgTypes.PairSuccess) {
          setPaired(true);
          setScreen("draw");
        }
        if (msg?.type === MsgTypes.JoinedRoom) {
          // ask server for latest board state (safe even if empty)
          send(MsgTypes.WbSnapshotRequest, {}, msg.roomId);
        }
      } catch {}
    };

    return () => ws.close();
  }, []);

  function send(type: string, payload: any, rid?: string) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ v: WS_VERSION, type, roomId: rid, payload }));
  }

  function joinRoomAndPair(rid: string, token: string) {
    setRoomId(rid);
    setPairToken(token);

    send(MsgTypes.JoinRoom, { roomId: rid });
    send(MsgTypes.PairClaim, { pairToken: token }, rid);
  }

  // Drawing area size
  const W = Dimensions.get("window").width;
  const H = Dimensions.get("window").height - 160;

  const style = useMemo(
    () => ({ tool: "pen" as const, color: "#111111", width: 0.006, opacity: 1 }),
    []
  );

  function norm(x: number, y: number): Point {
    const nx = Math.min(1, Math.max(0, x / W));
    const ny = Math.min(1, Math.max(0, y / H));
    return { x: nx, y: ny, t: Date.now() };
  }

  function onTouchStart(x: number, y: number) {
    const sid = nanoid(10);
    setActiveStrokeId(sid);

    const p = norm(x, y);
    setLocalPoints([p]);

    const start: StrokeMsg = { strokeId: sid, style, points: [p] };
    send(MsgTypes.WbStrokeStart, start, roomId);
  }

  function onTouchMove(x: number, y: number) {
    if (!activeStrokeId) return;

    const p = norm(x, y);
    setLocalPoints((prev) => [...prev, p]);

    const move: StrokeMsg = { strokeId: activeStrokeId, style, points: [p] };
    send(MsgTypes.WbStrokeMove, move, roomId);
    send(MsgTypes.CursorMove, { x: p.x, y: p.y, isDrawing: true }, roomId);
  }

  function onTouchEnd() {
    if (!activeStrokeId) return;
    const end: StrokeMsg = { strokeId: activeStrokeId, style, points: [] };
    send(MsgTypes.WbStrokeEnd, end, roomId);
    setActiveStrokeId(null);
  }

  if (!permission) {
    return (
      <SafeAreaView style={styles.container}>
        <Text>Requesting camera permission…</Text>
      </SafeAreaView>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.container}>
        <Text>No camera permission. Enable it in settings.</Text>
      </SafeAreaView>
    );
  }

  if (screen === "scan") {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.title}>inlko — Scan pairing QR</Text>
        <View style={{ height: 12 }} />
        <View style={styles.scannerWrap}>
          <CameraView
            style={StyleSheet.absoluteFillObject}
            onBarcodeScanned={({ data }) => {
              try {
                const parsed = JSON.parse(String(data));
                const rid = String(parsed.roomId ?? "");
                const token = String(parsed.pairToken ?? "");
                if (rid && token) joinRoomAndPair(rid, token);
              } catch {
                // ignore invalid scans
              }
            }}
          />
        </View>

        <View style={{ height: 12 }} />
        <Text style={styles.small}>Point camera at the QR shown in the web app.</Text>
      </SafeAreaView>
    );
  }

  // draw
  const polyPoints = localPoints.map((p) => `${p.x * W},${p.y * H}`).join(" ");

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>Companion Draw</Text>
      <Text style={styles.small}>Room: {roomId} • {paired ? "Paired" : "Pairing..."}</Text>

      <View style={{ height: 10 }} />
      <View
        style={[styles.drawArea, { width: W - 24, height: H }]}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(e) => onTouchStart(e.nativeEvent.locationX, e.nativeEvent.locationY)}
        onResponderMove={(e) => onTouchMove(e.nativeEvent.locationX, e.nativeEvent.locationY)}
        onResponderRelease={onTouchEnd}
        onResponderTerminate={onTouchEnd}
      >
        <Svg width="100%" height="100%">
          <Polyline
            points={polyPoints}
            fill="none"
            stroke="#111111"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </View>

      <View style={{ height: 10 }} />
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Button title="Undo" onPress={() => send(MsgTypes.WbUndo, {}, roomId)} />
        <Button title="Redo" onPress={() => send(MsgTypes.WbRedo, {}, roomId)} />
        <Button
          title="Clear (web too)"
          onPress={() => {
            setLocalPoints([]);
            send(MsgTypes.WbClear, {}, roomId);
          }}
        />
        <Button
          title="Scan again"
          onPress={() => {
            setPaired(false);
            setLocalPoints([]);
            setScreen("scan");
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 12, backgroundColor: "#fff" },
  title: { fontSize: 18, fontWeight: "600" },
  small: { fontSize: 12, color: "#444" },
  scannerWrap: { height: 420, borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: "#ddd" },
  drawArea: { borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: "#ddd", backgroundColor: "#fafafa" }
});
