# External broadcast processor

SUB/WAVE can send its finished mix to a broadcast audio processor on another machine and air what comes back. It was built for Breakaway One on Windows, but the bridge works with anything that takes audio in from a sound device and plays processed audio out to another: Stereo Tool, an Omnia or Optimod behind a sound card, and so on.

It is off by default. Turned off, the mixer builds nothing extra and airs exactly what it did before.

## How it works

```
 SUB/WAVE (broadcast container)                     Windows machine
 ─────────────────────────────                      ──────────────────────────────────────────
 music, voice, jingles, ducks
        │
        ▼
   idle gate ── SRT, UDP 9000 ──────────────────▶  bridge (Liquidsoap) ──▶ CABLE Input
        │        (raw 16-bit PCM, 44.1 kHz)                                    │
        │                                                                 CABLE Output
        │                                                                      │
        │                                                                 Breakaway One
        │                                                                      │
        │                                                                 CABLE-A Input
        │                                                                      │
   fallback ◀──── SRT, UDP 9001 ──────────────────  bridge (Liquidsoap) ◀── CABLE-A Output
   [processed, dry]
        │
        ▼
   bus limiter, ICY titles, every mount (/stream.mp3, Opus, FLAC, AAC, archive)
```

- **What gets processed.** The mixer sends the finished mix: music, DJ speech, jingles and ducks, after the idle gate and before the bus limiter. The processed audio comes back into the mixer and feeds every mount and the hourly archive, so stream titles, burst sizing and the Opus/FLAC/AAC mounts keep working as before.
- **Who connects to whom.** SUB/WAVE connects out to the bridge on both ports, so only the Windows machine needs firewall rules. The broadcast container needs no published ports.
- **The audio format.** Uncompressed 16-bit stereo PCM at 44.1 kHz, about 1.4 Mbit/s each way. It has no header, so either end can restart and pick up mid-stream.
- **If the processor goes away, the station keeps playing.** If the processed audio stops arriving (bridge closed, machine rebooting, network down, Breakaway stopped), the mixer airs the unprocessed ("dry") mix until the processed audio is back. Each switch is a hard cut: going to dry skips ahead by the processing delay (about 3 s), and coming back repeats about that much once.
- **Clock drift.** The Windows sound devices and the SUB/WAVE host keep slightly different time. Both ends absorb this by resampling very slightly (Liquidsoap's `buffer.adaptative`), so there is no periodic click.

## What you need on the Windows machine

| What | Where | Notes |
| --- | --- | --- |
| Breakaway One | [Claesson Edwards](https://www.claessonedwards.com/) · [quick-start guide (PDF)](https://www.claessonedwards.com/downloads/BreakawayOne_Quick_Start_Guide.pdf) · [forum](https://ceaforum.net/) | The guide says it needs a dedicated PC and does not support virtual machines. |
| Liquidsoap 2.4.6 for Windows | [GitHub release v2.4.6](https://github.com/savonet/liquidsoap/releases/tag/v2.4.6): `liquidsoap-2.4.6-win64.zip` | This runs the bridge. The Windows build includes SRT and PortAudio ([its build config](https://github.com/savonet/liquidsoap/releases/download/v2.4.6/liquidsoap-2.4.6-win64.config)). Use the same version as the broadcast image. |
| Two virtual audio cables | [VB-CABLE](https://vb-audio.com/Cable/) (one cable, free) plus VB-CABLE A+B (same page, donationware). Or [Virtual Audio Cable](https://vac.muzychenko.net/en/) (paid, any number of cables). | One cable carries the station into Breakaway and the other carries Breakaway's output back. Claesson Edwards also offers its own virtual device, Breakaway Pipeline; I have not confirmed how it shows up to other programs, so these steps use VB-CABLE. |
| The bridge script | [`tools/processor-bridge/subwave-bridge.liq`](../tools/processor-bridge/subwave-bridge.liq) in this repo | Copy it next to `liquidsoap.exe`. |

## Setup

### 1. Install the cables and set their format

Install VB-CABLE and VB-CABLE A+B, then reboot. In **Control Panel → Sound**, open each cable device (both the Playback and the Recording side) → **Properties → Advanced**, and set **16 bit, 44100 Hz**. SUB/WAVE runs at 44.1 kHz, and matching it everywhere avoids an extra Windows resample on each side.

### 2. Point Breakaway One at the cables

In Breakaway's configuration, for the processing core you use for the stream:

- **Input device:** `CABLE Output (VB-Audio Virtual Cable)`
- **Output device:** `CABLE-A Input (VB-Audio Cable A)`
- Run at 44.1 kHz if Breakaway offers the choice.
- Set the final output ceiling around **−1 dBFS**. SUB/WAVE's own bus limiter (20:1 at −1 dBFS) still runs after the processor to protect the MP3 encoder from inter-sample peaks, and a ceiling at or below it means that limiter does nothing.
- Use Breakaway's **gate** so silence stays silent. When nobody is listening, SUB/WAVE pauses the music and sends silence (the idle pause). An AGC that lifts that silence to full level will air noise.

The quick-start guide says to select an audio device, press **Auto Configure**, then **Run Test**, and not to select the same device in more than one I/O slot.

### 3. Set up the bridge

1. Unzip `liquidsoap-2.4.6-win64.zip`, for example to `C:\subwave-bridge\`, and copy `subwave-bridge.liq` into that folder.
2. Open a command prompt there and list the sound devices:

   ```
   liquidsoap.exe --list-portaudio-devices
   ```

3. Edit the top of `subwave-bridge.liq`:
   - `TO_PROCESSOR_DEVICE`: the playback side of the first cable, `CABLE Input (VB-Audio Virtual Cable)`.
   - `FROM_PROCESSOR_DEVICE`: the recording side of the second cable, `CABLE-A Output (VB-Audio Cable A)`.
   - Copy each name exactly as the device list prints it. Windows' MME driver cuts names at 31 characters, so the listed name can be shorter than the one in Sound settings.
   - Leave `SEND_PORT = 9000` and `RETURN_PORT = 9001` unless something else uses those ports.
4. Allow the two ports through Windows Firewall (an administrator command prompt):

   ```
   netsh advfirewall firewall add rule name="SUB/WAVE bridge" dir=in action=allow protocol=UDP localport=9000-9001
   ```

5. Run it:

   ```
   liquidsoap.exe subwave-bridge.liq
   ```

   It logs `SUB/WAVE bridge up: …`. Leave the window open while you test.

### 4. Turn it on in SUB/WAVE

**Admin → Settings → Broadcast & mixer → Advanced → External processor:**

- **Route the mix through an external processor:** On.
- **Bridge host:** the Windows machine's LAN IP address, for example `192.168.1.50`. A hostname works if the broadcast container can resolve it, but an IP address avoids the question.
- **Send port / return port:** `9000` / `9001`, the same as in the bridge script.
- **Processing delay:** start with **Breakaway's latency + 2200 ms** (see [Timing](#timing)).

Save, then press **Restart mixer** in the Mixer card. The card's subtitle shows what the running mixer is doing: `processed audio on air`, `return lost: airing the dry mix`, or `not in the chain`. The broadcast log (`state/logs/radio.log`) has `[processor]` lines for every switch.

### 5. Start the bridge with Windows

Once it works, make the bridge start without anyone logged in, the same way the Breakaway guide recommends running Breakaway as a service. Two ways:

- **As a Windows service.** The Windows build can install itself: `liquidsoap.exe --install-service --service-name SubwaveBridge C:\subwave-bridge\subwave-bridge.liq` (and `--remove-service --service-name SubwaveBridge` to undo). I have not tested this with sound devices. Services run in a separate session, so if the service starts but the bridge can't open the cables, use Task Scheduler instead.
- **With Task Scheduler.** Create a task that runs `C:\subwave-bridge\liquidsoap.exe` with the argument `subwave-bridge.liq`, starts in `C:\subwave-bridge`, and triggers **At log on** for the account Breakaway runs under.

## Timing

Listeners hear the stream `stream.bufferSeconds` (22 s by default) behind the live edge. The web player uses that figure to line up the track clock, lyrics and the booth's spoken captions with what the listener actually hears. The processor adds its delay on top.

**The processing delay setting** tells SUB/WAVE how much later the processed audio reaches the mounts than the dry mix would. While the processed audio is on air:

- `/now-playing` advertises `stream.bufferSeconds` plus this delay, and the `voice.*` webhooks carry the same figure as `streamBufferSeconds`, so the web player and anything else that reads either shifts by the same amount.
- The stream title change (ICY metadata) waits for the delay, so external players show the new song when it actually starts.

On the dry fallback neither shift applies, because the listener is hearing the mix with no processing delay.

What it does **not** change:

- **The scope and other visualizers.** They analyse the audio the browser is playing, so they are always in step on their own.
- **Operator screens** (admin, booth timings). They show live-edge times and never added the listener offset.
- **Anything the mixer schedules**: talk timing, ducks, crossfades and show-boundary fades all happen before the processor.

**Choosing the number.** The delay is the processor's own latency plus the network, the buffers on both ends and the two sound-device buffers on Windows. Measured on a local network with a pass-through in place of the processor, everything except the Windows sound devices came to about 1.86 s, steady over time. Start at Breakaway's reported latency + 2200 ms. Getting within a few hundred milliseconds is plenty: the 22 s listener buffer itself varies by about a second between players.

## Things to know

- **Ducking.** The DJ's ducks happen before the processor, and an AGC will partly lift a ducked bed back up. If the music sounds too loud under the DJ after turning processing on, deepen **Duck depth** in the same section.
- **Loudness levelling** (per-track gain) still runs before the processor, so tracks reach Breakaway at a consistent level.
- **Security.** The SRT legs are not encrypted. Keep them on your LAN, and don't forward ports 9000–9001 from the internet: whoever answers on the bridge host's address decides what the station airs.
- **SUB/WAVE Cloud** stations can't use this. The setting is hidden there and the mixer never builds the stage.
- **Idle skip edge case.** The web player's idle skip assumes no burst is longer than 60 s. With a 60 s listener buffer and the processor on, the real lag is 60 s plus the delay, so the skip can start up to the delay early. At the default 22 s buffer this cannot happen.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| The card says `return lost: airing the dry mix` | Is the bridge running? Can the broadcast host reach the Windows machine (same LAN, firewall rule added)? Do the host and ports match the bridge script? |
| The bridge exits with `Could not find portaudio device named …` | The error lists the available names. Copy one exactly into the script. |
| Processed audio airs but is silent | Breakaway's input or output is on the wrong cable, or Breakaway isn't processing. Its own meters show which. |
| Clicks or pitch wobble | Make every cable 44.1 kHz 16-bit (step 1), and make sure the Windows machine isn't overloaded. Breakaway's guide is firm about a dedicated PC. |
| The track clock or lyrics run early or late by a steady amount | Adjust **Processing delay**. Early means the number is too small. |
| The card flips between processed and dry | The return is arriving late in bursts (Wi-Fi, an overloaded machine). Each flip is logged in `radio.log`. Use a wired connection. |
