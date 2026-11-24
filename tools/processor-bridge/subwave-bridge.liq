# SUB/WAVE external processor bridge.
#
# Runs on the machine with the broadcast processor (Breakaway One, Stereo Tool,
# Omnia, a hardware box behind a sound card: anything that takes audio in from a
# sound device and plays processed audio out to another). It does two things:
#
#   1. takes the station's finished mix that SUB/WAVE sends over SRT and plays it
#      into the processor's INPUT device;
#   2. records the processor's OUTPUT device and sends it back to SUB/WAVE over
#      SRT, which airs it on every mount.
#
# SUB/WAVE connects to this bridge (it is the caller on both legs), so only this
# machine needs inbound firewall rules: UDP SEND_PORT and RETURN_PORT.
#
# Setup, device names and troubleshooting: docs/external-processor.md.
# List devices:  liquidsoap.exe --list-portaudio-devices   (then set the two IDs below)
# Run it with:   liquidsoap.exe subwave-bridge.liq

# ---------------------------------------------------------------------------
# EDIT THESE
# ---------------------------------------------------------------------------

# Must match Settings → Broadcast & mixer → External processor in SUB/WAVE.
SEND_PORT = 9000     # SUB/WAVE sends its mix here     (processor.sendPort)
RETURN_PORT = 9001   # SUB/WAVE collects audio here    (processor.returnPort)

# Devices are picked by ID, not name. Windows lists every sound device several
# times, once per driver type (MME, DirectSound, WASAPI, WDM-KS) and separately
# for its playback and recording sides, all under the same name, and a name
# lookup takes the first match whichever side it is. Find the IDs with:
#
#   liquidsoap.exe --list-portaudio-devices
#
# and pick, for each, an entry whose name is the right line or cable AND whose
# channel count is right for its direction. Prefer the MME entries (the lowest
# "host API" number, usually 0): MME converts the sample rate for you, where
# WASAPI refuses 44.1 kHz on a device set to 48 kHz.

# The device the bridge PLAYS the station mix into: needs "max output
# channels" of 2 or more. The processor's INPUT is the other end of it.
#   Breakaway Pipeline: e.g. "Line 1 (Breakaway Pipeline)", with Breakaway's
#     input set to Line 1.
#   VB-CABLE: "CABLE Input (VB-Audio Virtual Cable)", with the processor's
#     input set to "CABLE Output".
TO_PROCESSOR_DEVICE_ID = 0

# The device the bridge RECORDS the processed audio from: needs "max input
# channels" of 2 or more. The processor's OUTPUT is the other end of it.
#   Breakaway Pipeline: e.g. "Line 2 (Breakaway Pipeline)", with Breakaway's
#     output set to Line 2. Never the same line as above, or the station mix
#     loops straight back unprocessed.
#   VB-CABLE A+B: "CABLE-A Output (VB-Audio Cable A)", with the processor's
#     output set to "CABLE-A Input".
FROM_PROCESSOR_DEVICE_ID = 0

# Sound-device buffer, in samples per block. 2048 (about 46 ms) leaves the
# Windows drivers room to breathe; PortAudio's 256 is tight enough for MME to
# click when anything else on the machine is busy.
DEVICE_BUFLEN = 2048

# TROUBLESHOOTING ONLY. true sends the station's mix straight back without
# touching any sound device or the processor. Clicks that survive this come
# from the network or the SUB/WAVE side; clicks that go away come from the
# sound devices or the processor.
NETWORK_TEST = false

# ---------------------------------------------------------------------------
# Nothing below needs editing.
# ---------------------------------------------------------------------------

settings.log.stdout := true
settings.log.level := 3
settings.srt.prefer_address := "ipv4"

# Raw 16-bit stereo PCM at 44.1 kHz, the format SUB/WAVE sends and expects
# back. It has no header, so either end can reconnect mid-stream.
pcm = %ffmpeg(format="s16le", %audio(codec="pcm_s16le", ac=2, ar=44100))
pcm_type = "application/ffmpeg;format=s16le,ch_layout=stereo,sample_rate=44100"

# LEG 1: station → processor.
from_station = input.srt(
  id="from_station",
  mode="listener",
  port=SEND_PORT,
  content_type=pcm_type
)

# The SRT stream runs on SUB/WAVE's clock and the sound device on its own.
# buffer.adaptative bridges the two and resamples by a hair to absorb the drift
# that a fixed buffer would turn into a click every few hours.
# limit=1.001 caps that resampling at 0.1% (about 1.7 cents). The stock 1.25
# lets the speed follow every wobble in the buffer's fill by up to 25%, which
# sounds like the audio pitching up and down; real drift is parts per million.
# reset=true restarts the speed estimate after an underrun; without it the
# audio resumed slow and crept back, a click followed by a pitch sag. One
# second of prebuffer gives bursty arrival room before it runs dry.
to_processor = buffer.adaptative(
  id="to_processor_buffer",
  fallible=true,
  buffer=1.,
  max=10.,
  limit=1.001,
  averaging=60.,
  reset=true,
  from_station
)

returned =
  if NETWORK_TEST then
    log("NETWORK_TEST is on: the station mix goes straight back, no devices, no processor")
    mksafe(to_processor)
  else
    # mksafe keeps the device fed with silence while SUB/WAVE is not
    # connected, so the processor's input never disappears.
    output.portaudio(
      id="to_processor",
      device_id=TO_PROCESSOR_DEVICE_ID,
      buflen=DEVICE_BUFLEN,
      mksafe(to_processor)
    )
    # LEG 2: processor → station.
    input.portaudio(
      id="from_processor",
      device_id=FROM_PROCESSOR_DEVICE_ID,
      buflen=DEVICE_BUFLEN
    )
  end

to_station = output.srt(
  id="to_station",
  mode="listener",
  port=RETURN_PORT,
  pcm,
  returned
)

# Every 10 s: what SRT lost and what arrived too late to use. `late` is the one
# that clicks (a packet SRT gave up waiting for); `lost` is fine while `late`
# stays 0, because SRT resent it in time.
def srt_report(label, socks) =
  list.iter(
    fun (entry) -> begin
      let (_, raw) = entry
      st = srt.socket(raw).bstats()
      log(label="srt", "#{label}: lost #{st.pktRcvLossTotal} late #{st.pktRcvDropTotal} resent #{st.pktRetransTotal} send-dropped #{st.pktSndDropTotal} rtt #{st.msRTT} ms")
    end,
    socks
  )
end

# The buffer ahead of the processor: how full it is against its 1 s target,
# and the speed it plays at. A healthy one sits near 1 s and 1.000; a fill
# that swings, or a ratio pinned at 0.999 or 1.001, is audio arriving in bursts.
thread.run(every=10., fun () ->
  try
    log(label="buffer", "to processor: fill #{to_processor.duration()} s, speed x#{to_processor.ratio()}")
    srt_report("from station", from_station.sockets())
    srt_report("to station", to_station.sockets())
  catch err do
    log(label="srt", "stats failed (#{err})")
  end
)

log("SUB/WAVE bridge up: station mix in on UDP #{SEND_PORT} → device #{TO_PROCESSOR_DEVICE_ID}; device #{FROM_PROCESSOR_DEVICE_ID} → back out on UDP #{RETURN_PORT}")
