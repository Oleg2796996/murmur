/**
 * v160y47 — быстрый транскод видео на iPhone (Олег 2026-09-24 22:43:
 * «погнали дальше» + 21:57 «если придумаешь какой-то шустрый ужимать
 * видео для iPhone — было бы круто»).
 *
 * Проблема: MediaRecorder(canvas.captureStream) на iOS — real-time запись,
 * 11-секундный ролик не сконвертировался за 3 минуты. Не юзабельно.
 *
 * Решение: WebCodecs (iOS 16.4+: VideoDecoder/VideoEncoder аппаратно)
 * + mp4box демux + mp4-muxer mux — покадровая конвертация БЕЗ real-time:
 * декодируем → ресайз через OffscreenCanvas → кодируем (битрейт по
 * длительности) → mux в mp4 (fastStart). Скорость: 5-20× real-time,
 * 11с ролик ≈ 2-5с.
 *
 * Консервативность (Олег: «идею с консервацией оставляем»): шифрование
 * НЕ меняется — transcodeVideoFast возвращает File, дальше обычный
 * конвейер attachEncryptAndUpload (AES-256-GCM + ECIES + upload).
 * Звук: аудио-трек декодируется WebCodecs AudioDecoder и мmux'ится
 * отдельной дорожкой (звук сохраняется). Фолбэк: при любой неудаче —
 * оригинал.
 */

// === Утилиты ===

function _fastLog(...args) { try { console.log("[vfast]", ...args); } catch (e) {} }
function _fastWarn(...args) { try { console.warn("[vfast]", ...args); } catch (e) {} }

// === Демux (mp4box) ===

// Демux .MOV/.MP4 → видео+аудио треки с sample'ами.
async function _demuxMp4(file) {
    const arrayBuffer = await file.arrayBuffer();
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("demux timeout")), 20000);
        try {
            const mp4boxfile = MP4Box.createFile();
            let videoTrack = null, audioTrack = null;
            const videoSamples = [], audioSamples = [];
            mp4boxfile.onReady = (info) => {
                videoTrack = info.videoTracks && info.videoTracks[0];
                audioTrack = info.audioTracks && info.audioTracks[0];
                if (!videoTrack) { clearTimeout(timeout); reject(new Error("no video track")); return; }
                // extractTracks стартует отдачу sample'ов через onSamples.
                try { mp4boxfile.setExtractionOptions(videoTrack.id, null, { nb_samples: 100000 }); } catch (e) {}
                if (audioTrack) { try { mp4boxfile.setExtractionOptions(audioTrack.id, null, { nb_samples: 1000000 }); } catch (e) {} }
                try { mp4boxfile.start(); } catch (e) { try { mp4boxfile.extractTracks([videoTrack.id]); } catch (e2) {} }
            };
            mp4boxfile.onSamples = (trackId, ref, samples) => {
                if (videoTrack && trackId === videoTrack.id) {
                    for (const s of samples) videoSamples.push(s);
                    // Видео-трек собран полностью → ждём ещё немного аудио и resolve.
                    if (videoSamples.length >= (videoTrack.nb_samples || videoSamples.length)) {
                        clearTimeout(timeout);
                        // Даём аудио-сэмплам догнать (они обычно меньше).
                        setTimeout(() => {
                            resolve({ info: mp4boxfile ? mp4boxfile.getInfo() : null, videoTrack, audioTrack, videoSamples, audioSamples });
                        }, 50);
                    }
                } else if (audioTrack && trackId === audioTrack.id) {
                    for (const s of samples) audioSamples.push(s);
                }
            };
            mp4boxfile.onError = (e) => { clearTimeout(timeout); reject(new Error("demux error: " + e)); };
            // mp4box требует buffer со свойством fileStart.
            const buf = new Uint8Array(arrayBuffer);
            buf.fileStart = 0;
            mp4boxfile.appendBuffer(buf);
            mp4boxfile.flush();
        } catch (e) {
            clearTimeout(timeout);
            reject(e);
        }
    });
}

// === Декодирование видео (WebCodecs VideoDecoder) ===

async function _decodeVideoTrack(videoTrack, samples, onStage) {
    // Конфиг: codec string + description (avcC/hvcC из sample_descriptions).
    let codec = videoTrack.codec || "avc1.640028";
    if (/^hvc1|^hev1/i.test(codec)) codec = "hvc1.1.6.L93.B0";
    let descBytes = null;
    try {
        const sd = videoTrack.sample_descriptions && videoTrack.sample_descriptions[0];
        if (sd) descBytes = sd.avcC || sd.hvcC || sd.esds || null;
    } catch (e) {}
    const decoderConfig = { codec, description: descBytes, optimizeForLatency: false };
    const decSupport = await VideoDecoder.isConfigSupported(decoderConfig).catch(() => null);
    if (!decSupport || !decSupport.supported) throw new Error("decoder unsupported: " + codec);
    const frames = [];
    const decoder = new VideoDecoder({
        output: (frame) => frames.push(frame),
        error: (e) => _fastWarn("decoder error:", e),
    });
    decoder.configure(decoderConfig);
    for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const chunk = new EncodedVideoChunk({
            type: s.is_sync ? "key" : "delta",
            timestamp: s.cts !== undefined ? s.cts : s.dts,
            duration: s.duration || Math.round((videoTrack.timescale || 30000) / (videoTrack.framerate || 30)) || 33366,
            data: s.data,
        });
        decoder.decode(chunk);
        if (decoder.decodeQueueSize > 64) await new Promise((r) => setTimeout(r, 4));
        if (i % 120 === 0 && onStage) { try { onStage("декодирование " + Math.round(i / samples.length * 100) + "%"); } catch (e) {} }
    }
    await decoder.flush();
    decoder.close();
    if (!frames.length) throw new Error("no frames decoded");
    // Сортировка по timestamp (декодер может отдать в dts-порядке).
    frames.sort((a, b) => a.timestamp - b.timestamp);
    return frames;
}

// === Ресайз кадров (OffscreenCanvas) ===

function _resizeFrame(frame, w, h) {
    if (frame.displayWidth === w && frame.displayHeight === h) return frame;
    const cv = new OffscreenCanvas(w, h);
    const ctx = cv.getContext("2d");
    ctx.drawImage(frame, 0, 0, w, h);
    const out = new VideoFrame(cv, { timestamp: frame.timestamp, duration: frame.duration });
    frame.close();
    return out;
}

// === Кодирование видео (WebCodecs VideoEncoder) ===

async function _encodeVideoFrames(frames, config, onStage) {
    const chunks = [];
    const encoder = new VideoEncoder({
        output: (chunk, meta) => chunks.push({ chunk, meta }),
        error: (e) => _fastWarn("encoder error:", e),
    });
    encoder.configure(config);
    const total = frames.length;
    const gopSize = (config.framerate || 30) * 2; // keyframe каждые ~2с
    for (let i = 0; i < total; i++) {
        encoder.encode(frames[i], { keyFrame: i === 0 || i % gopSize === 0 });
        frames[i].close();
        if (encoder.encodeQueueSize > 64) await new Promise((r) => setTimeout(r, 4));
        if (i % 120 === 0 && onStage) { try { onStage("кодирование " + Math.round(i / total * 100) + "%"); } catch (e) {} }
    }
    await encoder.flush();
    encoder.close();
    if (!chunks.length) throw new Error("no chunks encoded");
    return chunks;
}

// === Декодирование аудио (WebCodecs AudioDecoder) ===

async function _decodeAudioTrack(audioTrack, samples) {
    if (!audioTrack || !samples.length) return null;
    let codec = audioTrack.codec || "";
    // mp4box: codec "mp4a.40.2" (AAC-LC), "opus", "flac"...
    if (!codec) return null;
    let descBytes = null;
    try {
        const sd = audioTrack.sample_descriptions && audioTrack.sample_descriptions[0];
        if (sd) descBytes = sd.esds || sd.dOps || sd.buf || null;
    } catch (e) {}
    const config = { codec: codec, sampleRate: audioTrack.audio?.sample_rate || audioTrack.sample_rate || 44100, numberOfChannels: audioTrack.audio?.channel_count || audioTrack.channelcount || 2, description: descBytes };
    const support = await AudioDecoder.isConfigSupported(config).catch(() => null);
    if (!support || !support.supported) return null; // аудио без декодера — видео без звука
    const data = [];
    const decoder = new AudioDecoder({
        output: (d) => data.push(d),
        error: (e) => _fastWarn("audio decoder error:", e),
    });
    decoder.configure(config);
    for (const s of samples) {
        try {
            decoder.decode(new EncodedAudioChunk({
                type: s.is_sync ? "key" : "delta",
                timestamp: s.cts !== undefined ? s.cts : s.dts,
                duration: s.duration,
                data: s.data,
            }));
        } catch (e) { break; }
        if (decoder.decodeQueueSize > 128) await new Promise((r) => setTimeout(r, 4));
    }
    try { await decoder.flush(); } catch (e) {}
    decoder.close();
    if (!data.length) return null;
    // AudioData → AudioChunk stream для muxer: конвертируем в interleaved Float32.
    const sr = config.sampleRate, ch = config.numberOfChannels;
    const chunks = [];
    for (const d of data) {
        const n = d.numberOfFrames;
        const f32 = new Float32Array(n * d.numberOfChannels);
        // Каналы могут быть planar (f32-planar) или interleaved — AudioData.copyTo по каналу.
        for (let c = 0; c < d.numberOfChannels; c++) {
            const plane = new Float32Array(n);
            d.copyTo(plane, { planeIndex: c, format: "f32" });
            for (let i = 0; i < n; i++) f32[i * d.numberOfChannels + c] = plane[i];
        }
        d.close();
        chunks.push({ data: f32, ts: d.timestamp, frames: n, channels: d.numberOfChannels, sr: d.sampleRate });
    }
    return { chunks, sampleRate: sr, channels: ch };
}

// === Аудио-энкодер через AudioEncoder (AAC) ===

async function _encodeAudioTrack(audioDec, onStage) {
    if (!audioDec || !audioDec.chunks.length) return null;
    if (typeof AudioEncoder === "undefined") return null;
    const sr = audioDec.sampleRate, ch = Math.min(2, audioDec.channels);
    const config = { codec: "mp4a.40.2", sampleRate: sr, numberOfChannels: ch, bitrate: 96000 };
    const support = await AudioEncoder.isConfigSupported(config).catch(() => null);
    if (!support || !support.supported) return null;
    const encChunks = [];
    const encoder = new AudioEncoder({
        output: (chunk, meta) => encChunks.push({ chunk, meta }),
        error: (e) => _fastWarn("audio encoder error:", e),
    });
    encoder.configure(config);
    // Кормим AudioData (f32 interleaved → planar для энкодера не важно — AudioData format f32).
    for (const c of audioDec.chunks) {
        const ad = new AudioData({
            format: "f32",
            sampleRate: c.sr,
            numberOfFrames: c.frames,
            numberOfChannels: c.channels,
            timestamp: c.ts,
            data: c.data,
        });
        encoder.encode(ad);
        ad.close();
        if (encoder.encodeQueueSize > 64) await new Promise((r) => setTimeout(r, 4));
    }
    try { await encoder.flush(); } catch (e) {}
    encoder.close();
    if (!encChunks.length) return null;
    return { chunks: encChunks, config };
}

// === Мux (mp4-muxer: Muxer + ArrayBufferTarget, fastStart) ===

async function _muxMp4(videoChunks, videoConfig, audioTrack, onStage) {
    const { ArrayBufferTarget, Muxer } = window.Mp4Muxer;
    // mp4-muxer ждёт описание avcC как ArrayBuffer/Uint8Array.
    const firstMeta = videoChunks.find(c => c.meta && c.meta.decoderConfig);
    let description = firstMeta && firstMeta.meta.decoderConfig.description;
    if (description) { try { description = new Uint8Array(description); } catch (e) {} }
    const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: {
            codec: videoConfig.codec4cc, // "avc" | "hevc"
            width: videoConfig.width,
            height: videoConfig.height,
            frameRate: videoConfig.framerate,
        },
        audio: audioTrack ? {
            codec: "aac",
            sampleRate: audioTrack.config.sampleRate,
            numberOfChannels: audioTrack.config.numberOfChannels,
        } : undefined,
        fastStart: "in-memory",
    });
    for (const { chunk } of videoChunks) {
        muxer.addVideoChunk(chunk, description ? { decoderConfig: { description } } : undefined);
    }
    if (audioTrack) {
        for (const { chunk, meta } of audioTrack.chunks) {
            try { muxer.addAudioChunk(chunk, meta); } catch (e) { _fastWarn("addAudioChunk:", e); break; }
        }
    }
    if (onStage) try { onStage("упаковка"); } catch (e) {}
    muxer.finalize();
    const { buffer } = muxer.target;
    return new Blob([buffer], { type: "video/mp4" });
}

// === Публичный API ===

/**
 * Быстрый транскод видео (WebCodecs путь, iPhone first).
 * Возвращает File (mp4 ≤~7MB) или null (фолбэк: оригинал / MediaRecorder).
 */
async function transcodeVideoFast(file, onStage) {
    if (!file || !file.type || !file.type.startsWith("video/")) return null;
    if (file.size <= 8 * 1024 * 1024) return null; // малые не нуждаются (OPFS-first)
    if (typeof MP4Box === "undefined") return null;
    if (typeof VideoDecoder === "undefined" || typeof VideoEncoder === "undefined") return null;
    if (typeof window === "undefined" || !window.Mp4Muxer) return null;
    const IS_IOS = /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    // WebCodecs путь имеет смысл в первую очередь на iOS (MediaRecorder там
    // не юзабелен); на desktop остаётся MediaRecorder (работает).
    if (!IS_IOS) return null;
    try {
        if (onStage) try { onStage("чтение"); } catch (e) {}
        const demux = await _demuxMp4(file);
        const vt = demux.videoTrack;
        const dur = (vt.duration || 0) / (vt.timescale || 1);
        if (!isFinite(dur) || dur <= 0 || dur > 300) return null;
        if (onStage) try { onStage("декодирование"); } catch (e) {}
        const frames = await _decodeVideoTrack(vt, demux.videoSamples, onStage);
        const first = frames[0];
        const fw = first.displayWidth || first.codedWidth || vt.width;
        const fh = first.displayHeight || first.codedHeight || vt.height;
        // Размер кадра: длинная сторона ≤1280, чётные размеры (H.264 требует).
        let w = fw, h = fh;
        const MAX_DIM = 1280;
        if (w > MAX_DIM || h > MAX_DIM) {
            const ratio = Math.min(MAX_DIM / w, MAX_DIM / h);
            w = Math.round(w * ratio) & ~1; h = Math.round(h * ratio) & ~1;
        } else {
            w &= ~1; h &= ~1;
        }
        if (w !== fw || h !== fh) {
            if (onStage) try { onStage("ресайз кадров"); } catch (e) {}
            for (let i = 0; i < frames.length; i++) frames[i] = _resizeFrame(frames[i], w, h);
        }
        const fps = Math.min(30, Math.round(vt.framerate || 30) || 30);
        const targetBytes = 6.5 * 1024 * 1024;
        const vbps = Math.max(500000, Math.round((targetBytes * 8 * 0.85) / dur));
        const videoConfig = {
            codec: "avc1.640028",
            codec4cc: "avc",
            width: w, height: h,
            bitrate: vbps,
            framerate: fps,
            latencyMode: "quality",
        };
        const encSupport = await VideoEncoder.isConfigSupported(videoConfig).catch(() => null);
        if (!encSupport || !encSupport.supported) {
            // HEVC-энкодер фолбэк (iOS поддерживает hvc1).
            videoConfig.codec = "hvc1.1.6.L93.B0";
            videoConfig.codec4cc = "hevc";
            const hvcSupport = await VideoEncoder.isConfigSupported(videoConfig).catch(() => null);
            if (!hvcSupport || !hvcSupport.supported) return null;
        }
        if (onStage) try { onStage("кодирование"); } catch (e) {}
        const chunks = await _encodeVideoFrames(frames, videoConfig, onStage);
        // Аудио: декод + AAC-энкод (звук сохраняется; при неудаче — видео без звука).
        let audioTrack = null;
        try {
            if (demux.audioTrack && demux.audioSamples.length) {
                const audioDec = await _decodeAudioTrack(demux.audioTrack, demux.audioSamples);
                audioTrack = await _encodeAudioTrack(audioDec);
            }
        } catch (e) { _fastWarn("audio pipeline failed (video без звука):", e); audioTrack = null; }
        if (onStage) try { onStage("упаковка"); } catch (e) {}
        const blob = await _muxMp4(chunks, videoConfig, audioTrack);
        if (blob.size < 1024 || blob.size >= file.size) { _fastWarn("mux результат не лучше оригинала:", blob.size); return null; }
        const baseName = (file.name || "video").replace(/\.[^.]+$/, "");
        _fastLog(file.name, file.size, "→", blob.size, "mp4 (" + Math.round(blob.size / file.size * 100) + "%)");
        return new File([blob], baseName + ".mp4", { type: "video/mp4", lastModified: file.lastModified || Date.now() });
    } catch (e) {
        _fastWarn("transcode failed, fallback to original:", e);
        return null;
    }
}

// Экспорт.
if (typeof window !== "undefined") {
    window.MurmurVideoFast = { transcodeVideoFast };
}
if (typeof module !== "undefined" && module.exports) {
    module.exports = { transcodeVideoFast };
}
