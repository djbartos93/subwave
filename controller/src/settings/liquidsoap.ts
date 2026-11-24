// One value per text file. Liquidsoap reads them once at mixer startup, so a
// change needs a restart; update() rewrites them on every save. A few are read
// by the Icecast renderers (docker/broadcast-entrypoint.sh, the AIO's
// supervisor.sh) instead, as marked. The renderers also read the three stream
// bitrates, to size each burst, and hand them on as SUBWAVE_*_BITRATE (#2143);
// radio.liq reads those files itself only when run without that handoff.

import { access, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { STATE_DIR } from '../config.js';
import { DEFAULTS } from './defaults.js';
// Pure policy module — no settings import of its own, so this stays acyclic.
import { mixerJingleRatioFile } from '../broadcast/jingle-rotate.js';
// Hosted stations: the station's bitrate ceiling (SUBWAVE_MAX_BITRATE).
import { capStreamBitrates, isHosted } from '../setup/hosted.js';
// Pure policy module, importing only schemas/settings.ts.
import { leadinFileName, rampFileContents, type DuckRampLayer } from '../broadcast/duck-ramp-policy.js';
import { DUCK_RAMP_LAYERS } from '../schemas/settings.js';
import { writeSilentWav } from '../audio/wav-silence.js';

export const LIQ_JINGLE_RATIO_PATH = `${STATE_DIR}/liquidsoap_jingle_ratio.txt`;
export const LIQ_CROSSFADE_PATH = `${STATE_DIR}/liquidsoap_crossfade.txt`;
// radio.liq's `smooth_add` `p` on the heavy voice layer and the light intro one.
export const LIQ_DUCK_VOICE_PATH = `${STATE_DIR}/liquidsoap_duck_voice.txt`;
export const LIQ_DUCK_INTRO_PATH = `${STATE_DIR}/liquidsoap_duck_intro.txt`;
// Duck ramp timing (duckRamp.<layer>): "downMin downMax upMin upMax" seconds,
// one file per smooth_duck layer.
export const liqDuckRampPath = (layer: DuckRampLayer) => `${STATE_DIR}/liquidsoap_duck_ramp_${layer}.txt`;
// The silent lead-ins the two voice layers push ahead of a clip, one per
// length (duck-ramp-policy.ts leadinFileName). Named by length and never
// rewritten, so a save before a mixer restart cannot change the lead-in the
// running mixer chose at startup. radio.liq falls back to /sounds/leadin.wav
// when its file is missing.
export const LEADIN_DIR = `${STATE_DIR}/leadin`;
// Plain crossfade curve (transitions.equalPowerCrossfade). Same read-once lifecycle.
export const LIQ_EQUAL_POWER_CROSSFADE_PATH = `${STATE_DIR}/liquidsoap_equal_power_crossfade.txt`;
// External processor (processor.*): radio.liq builds the SRT send/return stage
// only when enabled with a host, and re-checks every value itself.
export const LIQ_PROCESSOR_ENABLED_PATH = `${STATE_DIR}/liquidsoap_processor_enabled.txt`;
export const LIQ_PROCESSOR_HOST_PATH = `${STATE_DIR}/liquidsoap_processor_host.txt`;
export const LIQ_PROCESSOR_SEND_PORT_PATH = `${STATE_DIR}/liquidsoap_processor_send_port.txt`;
export const LIQ_PROCESSOR_RETURN_PORT_PATH = `${STATE_DIR}/liquidsoap_processor_return_port.txt`;
export const LIQ_PROCESSOR_DELAY_MS_PATH = `${STATE_DIR}/liquidsoap_processor_delay_ms.txt`;
export const LIQ_PROCESSOR_FAILOVER_MS_PATH = `${STATE_DIR}/liquidsoap_processor_failover_ms.txt`;
export const LIQ_ARCHIVE_ENABLED_PATH = `${STATE_DIR}/liquidsoap_archive_enabled.txt`;
export const LIQ_ARCHIVE_BITRATE_PATH = `${STATE_DIR}/liquidsoap_archive_bitrate.txt`;
export const LIQ_OPUS_ENABLED_PATH = `${STATE_DIR}/liquidsoap_opus_enabled.txt`;
const LIQ_OPUS_BITRATE_PATH = `${STATE_DIR}/liquidsoap_opus_bitrate.txt`;
const LIQ_FLAC_ENABLED_PATH = `${STATE_DIR}/liquidsoap_flac_enabled.txt`;
// Legacy Opus ICY compatibility handoff. FLAC ignores it and always uses
// native chained Ogg tags in radio.liq; retain the file for upgrade compatibility.
const LIQ_OGG_ICY_METADATA_PATH = `${STATE_DIR}/liquidsoap_ogg_icy_metadata.txt`;
const LIQ_AAC_ENABLED_PATH = `${STATE_DIR}/liquidsoap_aac_enabled.txt`;
const LIQ_AAC_BITRATE_PATH = `${STATE_DIR}/liquidsoap_aac_bitrate.txt`;
export const LIQ_STREAM_BITRATE_PATH = `${STATE_DIR}/liquidsoap_stream_bitrate.txt`;
// Entrypoint, not radio.liq: sizes Icecast's <burst-size> at broadcast boot.
export const LIQ_STREAM_BUFFER_SECONDS_PATH = `${STATE_DIR}/liquidsoap_stream_buffer_seconds.txt`;
// Entrypoint's too — Icecast <limits><clients>. The one file here that can
// LOSE: env ICECAST_MAX_CLIENTS wins, and the entrypoint logs which it took.
export const LIQ_ICECAST_MAX_CLIENTS_PATH = `${STATE_DIR}/liquidsoap_icecast_max_clients.txt`;
const LIQ_STATION_NAME_PATH = `${STATE_DIR}/liquidsoap_station_name.txt`;
// Entrypoint + AIO supervisor, not liquidsoap: only the literal 'true' renders
// the per-mount <authentication type="url"> blocks into icecast.xml.
export const ICECAST_LISTENER_AUTH_PATH = `${STATE_DIR}/icecast_listener_auth.txt`;

// The six listener-mount files, as the encoders must get them: the saved
// stream settings through a hosted station's bitrate ceiling. The archive is a
// local recording, not served to listeners, so it isn't capped. One list for
// the save below and the boot reconcile after it, so the two can't disagree.
function streamMountFiles(saved): [path: string, contents: string][] {
  const stream = capStreamBitrates(saved);
  return [
    [LIQ_OPUS_ENABLED_PATH, stream.opusEnabled ? 'true' : 'false'],
    [LIQ_OPUS_BITRATE_PATH, String(stream.opusBitrate)],
    [LIQ_FLAC_ENABLED_PATH, stream.flacEnabled ? 'true' : 'false'],
    [LIQ_AAC_ENABLED_PATH, stream.aacEnabled ? 'true' : 'false'],
    [LIQ_AAC_BITRATE_PATH, String(stream.aacBitrate)],
    [LIQ_STREAM_BITRATE_PATH, String(stream.bitrate)],
  ];
}

// Boot (settings.ensureLiquidsoapSettingsFile): rewrite each listener-mount
// file that disagrees with streamMountFiles(). A hosted station's ceiling is
// env, so it changes with no save to write it: a lowered ceiling must not leave
// 320 kbps and FLAC on disk, nor a raised one the old cap. Self-hosted, the
// files only disagree after a hand edit of settings.json, which this now
// carries through as a save would. These six only: the jingle ratio keeps its
// only-if-missing rule (broadcast/jingle-rotate.ts says why). The mixer reads
// them at its next start. Returns the basenames it rewrote.
export async function reconcileStreamMountFiles(s): Promise<string[]> {
  const rewrote: string[] = [];
  for (const [path, contents] of streamMountFiles(s.stream)) {
    let onDisk: string | null;
    try {
      onDisk = (await readFile(path, 'utf8')).trim();
    } catch {
      onDisk = null;
    }
    if (onDisk === contents) continue;
    await writeFile(path, contents);
    rewrote.push(basename(path));
  }
  return rewrote;
}

export async function writeLiquidsoapSettings(s) {
  // Not `s.jingleRatio` directly: with `jingleRotate: 'controller'` the mixer's
  // own rotate is switched off here (0 — #997's documented "jingles off"
  // value, so radio.liq needs no change) and the controller counts the tracks
  // instead. One resolver for both sides, so "the mixer is rotating" and "the
  // controller is rotating" cannot disagree. See broadcast/jingle-rotate.ts.
  await writeFile(LIQ_JINGLE_RATIO_PATH, mixerJingleRatioFile(s));
  await writeFile(LIQ_CROSSFADE_PATH, String(s.crossfadeDuration));
  // Defaulted like `station`: `undefined` in the handoff file unducks the DJ.
  await writeFile(LIQ_DUCK_VOICE_PATH, String(s.ducking?.voice ?? DEFAULTS.ducking.voice));
  await writeFile(LIQ_DUCK_INTRO_PATH, String(s.ducking?.intro ?? DEFAULTS.ducking.intro));
  const ramps = s.duckRamp ?? DEFAULTS.duckRamp;
  for (const layer of DUCK_RAMP_LAYERS) {
    await writeFile(liqDuckRampPath(layer), rampFileContents(ramps[layer] ?? DEFAULTS.duckRamp[layer]));
  }
  await ensureLeadinWavs(s);
  // Only an explicit true writes "true": absent or malformed stays linear.
  await writeFile(LIQ_EQUAL_POWER_CROSSFADE_PATH, String(s.transitions?.equalPowerCrossfade === true));
  // Only an explicit true builds the stage: absent or malformed stays off, and
  // a hosted station never builds it, whatever a restored settings.json holds
  // (setup/hosted.ts drops the key from patches for the same reason).
  const proc = s.processor ?? DEFAULTS.processor;
  await writeFile(LIQ_PROCESSOR_ENABLED_PATH, String(proc.enabled === true && !isHosted()));
  await writeFile(LIQ_PROCESSOR_HOST_PATH, String(proc.host ?? ''));
  await writeFile(LIQ_PROCESSOR_SEND_PORT_PATH, String(proc.sendPort ?? DEFAULTS.processor.sendPort));
  await writeFile(LIQ_PROCESSOR_RETURN_PORT_PATH, String(proc.returnPort ?? DEFAULTS.processor.returnPort));
  await writeFile(LIQ_PROCESSOR_DELAY_MS_PATH, String(proc.delayMs ?? DEFAULTS.processor.delayMs));
  await writeFile(LIQ_PROCESSOR_FAILOVER_MS_PATH, String(proc.failoverMs ?? DEFAULTS.processor.failoverMs));
  await writeFile(LIQ_ARCHIVE_ENABLED_PATH, s.archive.enabled ? 'true' : 'false');
  await writeFile(LIQ_ARCHIVE_BITRATE_PATH, String(s.archive.bitrate));
  // The listener-facing mounts, under a hosted station's bitrate ceiling.
  for (const [path, contents] of streamMountFiles(s.stream)) await writeFile(path, contents);
  await writeFile(LIQ_OGG_ICY_METADATA_PATH, s.stream.oggIcyMetadata ? 'true' : 'false');
  await writeFile(LIQ_STREAM_BUFFER_SECONDS_PATH, String(s.stream.bufferSeconds));
  await writeFile(LIQ_ICECAST_MAX_CLIENTS_PATH, String(s.stream.maxListeners));
  await writeFile(LIQ_STATION_NAME_PATH, s.station || DEFAULTS.station);
  await writeFile(
    ICECAST_LISTENER_AUTH_PATH,
    s.privacy?.listenerAuth ? 'true' : 'false',
  );
}

// Both voice layers' lead-ins, for the save above and for boot
// (settings.ensureLiquidsoapSettingsFile), so a cleared leadin/ folder is
// refilled before the mixer next starts.
export async function ensureLeadinWavs(s): Promise<void> {
  const ramps = s.duckRamp ?? DEFAULTS.duckRamp;
  for (const layer of ['voice', 'intro'] as const) {
    await ensureLeadinWav(ramps[layer] ?? DEFAULTS.duckRamp[layer]);
  }
}

// Writes the lead-in for a voice layer's ramp if it is not on disk yet. A
// failure is logged and survivable: radio.liq airs the shipped 0.8 s lead-in
// when the file is missing.
async function ensureLeadinWav(ramp: { downMax: number }): Promise<void> {
  const path = `${LEADIN_DIR}/${leadinFileName(ramp as never)}`;
  try {
    await access(path);
    return;
  } catch { /* missing: write it */ }
  try {
    await writeSilentWav(path, ramp.downMax * 1000);
  } catch (err) {
    console.warn(`[settings] could not write ${path}: ${(err as Error).message}`);
  }
}
