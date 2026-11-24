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
# Run it with:   liquidsoap.exe subwave-bridge.liq
# List devices:  liquidsoap.exe --list-portaudio-devices

# ---------------------------------------------------------------------------
# EDIT THESE
# ---------------------------------------------------------------------------

# Must match Settings → Broadcast & mixer → External processor in SUB/WAVE.
SEND_PORT = 9000     # SUB/WAVE sends its mix here     (processor.sendPort)
RETURN_PORT = 9001   # SUB/WAVE collects audio here    (processor.returnPort)

# The device the bridge PLAYS the station mix into. The processor's input
# device is the other end of this virtual cable.
# Example with VB-CABLE: the bridge plays to "CABLE Input", the processor's
# input is "CABLE Output".
TO_PROCESSOR_DEVICE = "CABLE Input (VB-Audio Virtual Cable)"

# The device the bridge RECORDS the processed audio from. The processor's
# output device is the other end of this cable.
# Example with VB-CABLE A+B: the processor outputs to "CABLE-A Input", the
# bridge records "CABLE-A Output".
FROM_PROCESSOR_DEVICE = "CABLE-A Output (VB-Audio Cable A)"

# Copy names exactly as `liquidsoap.exe --list-portaudio-devices` prints them.
# Windows' MME driver cuts names at 31 characters, so the listed name may be
# shorter than the one in Sound settings.

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
to_processor = buffer.adaptative(
  id="to_processor_buffer",
  fallible=true,
  buffer=0.5,
  max=5.,
  from_station
)

# mksafe keeps the device fed with silence while SUB/WAVE is not connected,
# so the processor's input never disappears.
output.portaudio(
  id="to_processor",
  device_name=TO_PROCESSOR_DEVICE,
  mksafe(to_processor)
)

# LEG 2: processor → station.
from_processor = input.portaudio(
  id="from_processor",
  device_name=FROM_PROCESSOR_DEVICE
)

output.srt(
  id="to_station",
  mode="listener",
  port=RETURN_PORT,
  pcm,
  from_processor
)

log("SUB/WAVE bridge up: station mix in on UDP #{SEND_PORT} → #{TO_PROCESSOR_DEVICE}; #{FROM_PROCESSOR_DEVICE} → back out on UDP #{RETURN_PORT}")
