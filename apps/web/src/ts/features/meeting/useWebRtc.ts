import { useCallback, useMemo, useRef, useState } from "react";
import { MsgTypes } from "@inlko/shared";

type RemoteStreamMap = Record<string, MediaStream>;

type PeerState = {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
};

type UseWebRtcArgs = {
  roomId: string;
  localUserId?: string;
  send: (type: string, payload: any, roomId?: string) => void;
};

export function useWebRtc({ roomId, localUserId, send }: UseWebRtcArgs) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<RemoteStreamMap>({});
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);
  const [peerStatus, setPeerStatus] = useState<Record<string, RTCPeerConnectionState>>({});
  const screenStreamRef = useRef<MediaStream | null>(null);

  const peersRef = useRef<Map<string, PeerState>>(new Map());

  const rtcConfig = useMemo<RTCConfiguration>(() => {
    // No third-party services. This will work best on same LAN.
    // Later you can add your own TURN server (coturn) here.
    return { iceServers: [] };
  }, []);

  const attachLocalTracks = useCallback(
    (pc: RTCPeerConnection) => {
      if (!localStream) return;
      for (const track of localStream.getTracks()) {
        const alreadyAdded = pc.getSenders().some((s) => s.track?.id === track.id);
        if (!alreadyAdded) pc.addTrack(track, localStream);
      }
    },
    [localStream]
  );

  const ensurePeer = useCallback(
    (remoteUserId: string) => {
      if (!localUserId) return null;
      if (remoteUserId === localUserId) return null;

      const existing = peersRef.current.get(remoteUserId);
      if (existing) return existing;

      const polite = localUserId.localeCompare(remoteUserId) > 0;

      const pc = new RTCPeerConnection(rtcConfig);

      const state: PeerState = {
        pc,
        polite,
        makingOffer: false,
        ignoreOffer: false
      };

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        send(
          MsgTypes.RtcIce,
          { toUserId: remoteUserId, candidate: ev.candidate.toJSON() },
          roomId
        );
      };

      pc.ontrack = (ev) => {
        const stream = ev.streams[0];
        if (!stream) return;
        setRemoteStreams((prev) => ({ ...prev, [remoteUserId]: stream }));
      };

      pc.onconnectionstatechange = () => {
        setPeerStatus((prev) => ({ ...prev, [remoteUserId]: pc.connectionState }));
      };

      // Add tracks if we already have local media
      attachLocalTracks(pc);

      // Perfect negotiation: handle negotiationneeded by creating an offer
      pc.onnegotiationneeded = async () => {
        try {
          state.makingOffer = true;
          await pc.setLocalDescription(await pc.createOffer());
          send(
            MsgTypes.RtcOffer,
            { toUserId: remoteUserId, sdp: pc.localDescription },
            roomId
          );
        } catch {
          // ignore for MVP
        } finally {
          state.makingOffer = false;
        }
      };

      peersRef.current.set(remoteUserId, state);
      setPeerStatus((prev) => ({ ...prev, [remoteUserId]: pc.connectionState }));
      return state;
    },
    [attachLocalTracks, localUserId, roomId, rtcConfig, send]
  );

  const replaceVideoTrackForAll = useCallback(async (newTrack: MediaStreamTrack | null) => {
    for (const [, st] of peersRef.current) {
      const sender = st.pc.getSenders().find((s) => s.track?.kind === "video");
      if (!sender) continue;
      try {
        await sender.replaceTrack(newTrack);
      } catch {
        // ignore for MVP
      }
    }
  }, []);

  const closePeer = useCallback((remoteUserId: string) => {
    const state = peersRef.current.get(remoteUserId);
    if (!state) return;

    try {
      state.pc.ontrack = null;
      state.pc.onicecandidate = null;
      state.pc.onnegotiationneeded = null;
      state.pc.close();
    } catch {}

    peersRef.current.delete(remoteUserId);
    setRemoteStreams((prev) => {
      const copy = { ...prev };
      delete copy[remoteUserId];
      return copy;
    });
    setPeerStatus((prev) => {
      const copy = { ...prev };
      delete copy[remoteUserId];
      return copy;
    });
  }, []);

  const startMedia = useCallback(
    async (opts?: { audio?: boolean; video?: boolean }) => {
      const audio = opts?.audio ?? true;
      const video = opts?.video ?? true;

      const stream = await navigator.mediaDevices.getUserMedia({ video, audio });
      setLocalStream(stream);

      // if user chose off, disable tracks immediately
      for (const t of stream.getAudioTracks()) t.enabled = audio && micEnabled;
      for (const t of stream.getVideoTracks()) t.enabled = video && camEnabled;

      for (const [, s] of peersRef.current) attachLocalTracks(s.pc);

      return stream;
    },
    [attachLocalTracks, camEnabled, micEnabled]
  );

  const startScreenShare = useCallback(async () => {
    // @ts-expect-error - TS sometimes needs lib.dom adjustments
    const displayStream: MediaStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = displayStream.getVideoTracks()[0];
    if (!track) return;

    screenStreamRef.current = displayStream;

    // Replace outgoing video to peers
    await replaceVideoTrackForAll(track);

    // Also show local preview as the shared screen
    setLocalStream((prev) => {
      if (!prev) return displayStream;

      // keep audio from previous stream if any
      const audioTracks = prev.getAudioTracks();
      const mixed = new MediaStream([track, ...audioTracks]);
      return mixed;
    });

    // When user stops sharing from browser UI, revert to camera
    track.onended = () => {
      stopScreenShare();
    };
  }, [replaceVideoTrackForAll]);

  const stopScreenShare = useCallback(async () => {
    const displayStream = screenStreamRef.current;
    if (displayStream) {
      for (const t of displayStream.getTracks()) t.stop();
      screenStreamRef.current = null;
    }

    // Re-acquire camera video (keep existing audio if possible)
    const camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const camTrack = camStream.getVideoTracks()[0];
    if (!camTrack) return;

    // Respect camEnabled
    camTrack.enabled = camEnabled;

    await replaceVideoTrackForAll(camTrack);

    setLocalStream((prev) => {
      const audioTracks = prev ? prev.getAudioTracks() : [];
      return new MediaStream([camTrack, ...audioTracks]);
    });
  }, [camEnabled, replaceVideoTrackForAll]);

  const stopMedia = useCallback(() => {
    setLocalStream((s) => {
      if (s) {
        for (const t of s.getTracks()) t.stop();
      }
      return null;
    });
  }, []);

  const toggleMic = useCallback(() => {
    setMicEnabled((v) => {
      const next = !v;
      if (localStream) for (const t of localStream.getAudioTracks()) t.enabled = next;
      return next;
    });
  }, [localStream]);

  const toggleCam = useCallback(() => {
    setCamEnabled((v) => {
      const next = !v;
      if (localStream) for (const t of localStream.getVideoTracks()) t.enabled = next;
      return next;
    });
  }, [localStream]);

  const handlePeers = useCallback(
    (peers: string[]) => {
      for (const pid of peers) ensurePeer(pid);
    },
    [ensurePeer]
  );

  const handlePeerJoined = useCallback(
    (peerId: string) => {
      ensurePeer(peerId);
    },
    [ensurePeer]
  );

  const handlePeerLeft = useCallback(
    (peerId: string) => {
      closePeer(peerId);
    },
    [closePeer]
  );

  const handleSignal = useCallback(
    async (msg: any) => {
      if (!localUserId) return;
      const fromUserId = msg.userId as string | undefined;
      if (!fromUserId) return;

      const state = ensurePeer(fromUserId);
      if (!state) return;

      const pc = state.pc;

      // Offer
      if (msg.type === MsgTypes.RtcOffer) {
        const offer = msg.payload?.sdp as RTCSessionDescriptionInit | undefined;
        if (!offer) return;

        const offerCollision = state.makingOffer || pc.signalingState !== "stable";
        state.ignoreOffer = !state.polite && offerCollision;
        if (state.ignoreOffer) return;

        await pc.setRemoteDescription(offer);
        attachLocalTracks(pc);

        await pc.setLocalDescription(await pc.createAnswer());
        send(
          MsgTypes.RtcAnswer,
          { toUserId: fromUserId, sdp: pc.localDescription },
          roomId
        );
        return;
      }

      // Answer
      if (msg.type === MsgTypes.RtcAnswer) {
        const answer = msg.payload?.sdp as RTCSessionDescriptionInit | undefined;
        if (!answer) return;
        await pc.setRemoteDescription(answer);
        return;
      }

      // ICE
      if (msg.type === MsgTypes.RtcIce) {
        const candidate = msg.payload?.candidate as RTCIceCandidateInit | undefined;
        if (!candidate) return;

        try {
          await pc.addIceCandidate(candidate);
        } catch {
          if (!state.ignoreOffer) throw undefined;
        }
      }
    },
    [attachLocalTracks, ensurePeer, localUserId, roomId, send]
  );

  const closeAll = useCallback(() => {
    for (const [id] of peersRef.current) closePeer(id);
  }, [closePeer]);

  return {
    localStream,
    remoteStreams,
    peerStatus,
    micEnabled,
    camEnabled,
    startMedia,
    stopMedia,
    startScreenShare,
    stopScreenShare,
    toggleMic,
    toggleCam,
    handlePeers,
    handlePeerJoined,
    handlePeerLeft,
    handleSignal,
    closeAll
  };
}
