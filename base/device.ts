import Homey from 'homey';
import TuyaDevice, { TuyaDeviceOptions } from 'tuyapi'; // https://codetheweb.github.io/tuyapi/index.html
import { BaseDriver } from './driver';

// Hard timeouts to prevent stuck Promises from piling up and freezing the app.
// These apply to all network-bound operations.
// Timeouts tuned to avoid premature "timeout key 20" errors during wake-up after power restore.
const CONNECT_TIMEOUT_MS = 10000;
const SET_TIMEOUT_MS = 10000;
const REFRESH_TIMEOUT_MS = 12000; // main poll/refresh
const HEALTH_REFRESH_TIMEOUT_MS = 5000; // lightweight online health refresh

export enum TuyaProtocolVersion {
  V3_3 = '3.3',
  V3_4 = '3.4',
  V3_5 = '3.5',
}

export interface ICapabilityMap {
  capability: string;
  dp: string;
  toDevice: (value: any) => any;
  fromDevice: (value: any) => any;
  local?: boolean;
}

interface IKeyValue {
  [key: string]: boolean | string | number | undefined | null
}

export class BaseDevice extends Homey.Device {
  private pendingAutoPollOnOff: boolean | null = null;
  private suppressPowerRestoreOnce: boolean = false;
  private connectedShownThisSession: boolean = false;
  device!: TuyaDevice;
  driver!: BaseDriver;
  capabilityMap: ICapabilityMap[] = [];
  settings: IKeyValue = {};

  private switchPollTimer: NodeJS.Timeout | null = null;
  private switchPollTimeout: NodeJS.Timeout | null = null;
  private offlineStartedAt: number | null = null;
  
  private offlineSince: number | null = null;
private pollInFlight = false;
  private smartPollToken = 0;
  // Pending action loops for Settings toggles (reconnect_now / reset_learning)
  private pendingReconnectCancelId = 0;
  private pendingResetCancelId = 0;
  private consecutiveTimeouts = 0;
  private smartPollPausedUntil = 0;
  // Backoff on repeated smart-poll failures (per device, resets on success)
  private smartPollBackoffLevel = 0;
  private smartPollWindowStart = 0;
  private smartPollCountInWindow = 0;
  private smartPollingArmed = false;
  private smartPollCountdownInterval: NodeJS.Timeout | null = null;
  private smartPollUsingFallback = false;
  private lastReconnectEwmaSec: number | null = null;
  private lastSmartPollStatus: string | null = null;
  private lastSmartPollPhase: number | null = null;
  // Random jitter (per device, per phase) to desynchronize many devices.
  private lastJitterPhase: number | null = null;
  private lastPhaseJitterSec = 0;
  private nextSmartPollAt: number | null = null;
  // Phase-3 "probe" polls: a few random extra attempts while waiting on long intervals.
  // Reset each time the device disconnects.
  private phase3ProbeLeft = 3;
  private phase3LastProbeScheduledAt = 0;
  // For UI: show planned interval vs. an eventual probe interval.
  private lastPlannedIntervalSec: number | null = null;
  private lastEffectiveIntervalSec: number | null = null;
  private lastWasProbe = false;
  private lastLearningTotal = 0;
  private countdownInterval: any = null;
  private lastCountdownText: string | null = null;
  private countdownIntervalSec: number = 0;
  private lastSurvivalBucketIdx: number = -1;
  private lastPhase2EndSec: number | null = null;
  private wasDisconnected = false;
  private lastManualReconnectAt = 0;
  private disconnectDebounceTimer: NodeJS.Timeout | null = null;
  private disconnectedDebounced = false;
  private suppressLastStateStore = false;

  // Minimal online health monitoring to detect power loss when no disconnect event is emitted.
  private onlineHealthTimer: NodeJS.Timeout | null = null;
  private lastContactAt = 0;

  private getSmartPollBackoffMultiplier(): number {
    // Backoff levels: 0->1x, 1->1.5x, 2->2x, 3->3x, 4+->5x
    const lvl = Math.max(0, this.smartPollBackoffLevel || 0);
    if (lvl <= 0) return 1;
    if (lvl === 1) return 1.5;
    if (lvl === 2) return 2;
    if (lvl === 3) return 3;
    return 5;
  }

  private noteSmartPollResult(success: boolean) {
    // Only apply backoff while we are in an offline session (switch-mode workflow)
    if (!this.wasDisconnected || !this.disconnectedDebounced) {
      this.smartPollBackoffLevel = 0;
      return;
    }
    if (success) {
      this.smartPollBackoffLevel = 0;
      return;
    }
    this.smartPollBackoffLevel = Math.min(4, (this.smartPollBackoffLevel || 0) + 1);
  }

  private async isPhaseJitterEnabled(): Promise<boolean> {
    try {
      const app: any = this.homey?.app;
      if (app && typeof app.isJitterEnabledAuto === 'function') {
        return await app.isJitterEnabledAuto();
      }
    } catch (e) {
      // ignore
    }
    return false;
  }


  protected tuyaProtocolVersion = TuyaProtocolVersion.V3_3;

  deleteDevice() {
    this.log('Remove TuyaDevice');
    if (this.device && this.device.isConnected()) {
      this.device.removeAllListeners();
      this.device.disconnect();
      this.device = null as any;
    }
  }



  private isTimeoutError(err: unknown): boolean {
    return String(err).includes('timeout');
  }


  private enforceSmartPollHourlyCap(): boolean {
    const MAX_PER_HOUR = 120;
    const WINDOW_MS = 60 * 60 * 1000;

    const now = Date.now();
    if (!this.smartPollWindowStart || (now - this.smartPollWindowStart) >= WINDOW_MS) {
      this.smartPollWindowStart = now;
      this.smartPollCountInWindow = 0;
    }

    if (this.smartPollCountInWindow >= MAX_PER_HOUR) {
      const waitMs = (this.smartPollWindowStart + WINDOW_MS) - now;
      this.smartPollPausedUntil = Math.max(this.smartPollPausedUntil, now + Math.max(0, waitMs));
      return false;
    }

    this.smartPollCountInWindow += 1;
    return true;
  }

  private pauseSmartPolling(reason: string) {
    // Pause smart polling for a minute after repeated timeouts to avoid hammering the device/stack.
    this.smartPollPausedUntil = Date.now() + 20000;
    this.log(`Smart polling paused: ${reason}`);
  }

  private async updateSmartPollStatus(status: string) {
    try {
      if (this.lastSmartPollStatus === status) return;
      this.lastSmartPollStatus = status;
      await this.setSettings({ smart_poll_status: status } as any);
    } catch (e) {
      this.error(e);
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const t = this.homey.setTimeout(() => {
        reject(new Error(`${label} timeout after ${ms}ms`));
      }, ms);
      promise
        .then((v) => {
          this.homey.clearTimeout(t);
          resolve(v);
        })
        .catch((e) => {
          this.homey.clearTimeout(t);
          reject(e);
        });
    });
  }

  private async resetTuyaDevice(reason: string) {
    try {
      this.log(`Reset TuyaDevice: ${reason}`);
      this.deleteDevice();
      await this.createDevice();
    } catch (err) {
      this.error(err);
    }
  }

  async createDevice() {
    this.deleteDevice();
    this.log('Create TuyaDevice');

    if (this.settings.id && this.settings.key && this.settings.ip) {
      try {
        this.device = new TuyaDevice({
          ...this.settings,
          version: this.tuyaProtocolVersion,
        } as TuyaDeviceOptions);
      } catch (error) {
        await this.setUnavailable(this.homey.__('error.device.create_device', { error }));
      }

      if (this.device) {
        this.device.on('connected', () => this.onConnected());
        this.device.on('disconnected', () => this.onDisconnected());
        this.device.on('error', (error:any) => this.onError(error));
        this.device.on('dp-refresh', (data:any) => this.onDpRefresh(data));
        this.device.on('heartbeat', () => this.onHeartbeat());
        this.device.on('data', (data:any) => this.onData(data));

        await this.connect();
        await this.setAvailable();
        this.lastContactAt = Date.now();
        // Visible feedback on real offline → online transition (all modes)
        if (this.offlineSince && !this.connectedShownThisSession) {
          this.connectedShownThisSession = true;
          this.offlineSince = null;
          try {
            const msg = 'Device connected';
            this.transientWarningText = msg;
            this.transientWarningLockUntil = Date.now() + 2800;
            await this.setWarning(msg);
            this.homey.setTimeout(() => this.unsetWarning().catch(() => {}), 3000);
          } catch (_) {}
        }

        this.startOnlineHealthMonitor();
          this.stopUnavailableCountdown();
          // Don't clear a transient "Poll starting" hint too early
          if (!this.transientWarningText || Date.now() >= this.transientWarningLockUntil) {
            this.unsetWarning().catch(this.error);
          }

      this.stopDisconnectDebounce();
      this.disconnectedDebounced = false;
      this.suppressLastStateStore = false;
      }
    } else {
      await this.setUnavailable(this.homey.__('error.device.missing_attributes', this.settings));
    }
  }

  async connect() {
    const autoPoll = !!this.getSetting('auto_poll');
    const smartMode = !!this.getSetting('smart_polling');
    const inOfflineSession = this.wasDisconnected || !!this.offlineStartedAt || this.disconnectedDebounced;

    // In Auto-Poll (Smart OFF) we intentionally keep the device available and reduce banner churn.
    // Also: do not clear a transient hint (e.g. "Poll starting…") before it had a chance to be visible.
    if (!(autoPoll && !smartMode && inOfflineSession)) {
      if (!this.transientWarningText || Date.now() >= this.transientWarningLockUntil) {
        this.unsetWarning();
      }
    }

    if (this.device) {
      if (this.device.isConnected()) return true;

      try {
        await this.withTimeout(this.device.connect(), CONNECT_TIMEOUT_MS, 'connect');
        return true;
      } catch (error) {
        if (autoPoll && !smartMode && inOfflineSession) {
          this.offlinePollCounter = (this.offlinePollCounter || 0) + 1;
          if (this.offlinePollCounter % 2 === 0) {
            const msg = 'Device is currently not available (Auto-Poll is running)';
            this.setWarning(msg).catch(this.error);
          }
        } else {
          if (!(this.offlineUserOnOffPending && !this.getSetting('auto_poll') && !this.getSetting('smart_polling'))) {
            this.setWarning(this.homey.__('error.device.fail_to_connect', { device: this.getName() }));
          }
        }
                if (!this.offlineSince) { this.offlineSince = Date.now(); this.connectedShownThisSession = false; }
if (String(error).includes('timeout')) await this.resetTuyaDevice('connect timeout');
        return false;
      }
    }

    if (!(this.offlineUserOnOffPending && !this.getSetting('auto_poll') && !this.getSetting('smart_polling'))) {
      this.setWarning(this.homey.__('error.device.no_device', { device: this.getName() }));
    if (!this.offlineSince) { this.offlineSince = Date.now(); this.connectedShownThisSession = false; }
}
    return false;
  }

  private getOnOffDpKey(): string {
    const entry = this.capabilityMap.find(c => c.capability === 'onoff');
    return entry?.dp ?? '20';
  }

  async setDeviceValue(key: string, value: any) {
    if (await this.connect()) {
      try {
        await this.withTimeout(this.device.set({ dps: parseInt(key, 10), set: value }), SET_TIMEOUT_MS, 'set');
      } catch (error) {
        const msg = String((error as any)?.message ?? error);
        // Avoid scaring the user with internal backoff/rate-limit messages like "abort until 10000ms".
        if (msg.includes('abort until') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('backoff')) {
          this.log(`Suppressed internal poll/backoff message for key ${key}:`, msg);
          return;
        }
        this.setWarning(this.homey.__('error.device.setting_device_value', { key, error }));
        this.log(`Error setting device value for key ${key}:`, error);
      }
    }
  }

  setCapabilitiyValues(capabilities: IKeyValue) {
    if (capabilities) {
      Object.keys(capabilities).forEach(key => {
        this.capabilityMap.filter(cap => cap.dp === key).forEach(cap => {
          // If the user has pressed ON/OFF while offline (Auto-Poll OFF), keep the UI
          // stable (no flicker) until we have successfully reached the device and
          // applied the desired state.
          if (cap.capability === 'onoff' && this.offlineUserOnOffPending && this.offlineUserOnOffDesired !== null) {
            return;
          }
          // Mode 1: if user pressed ON/OFF while offline and we are waiting for Auto-Poll reconnect,
          // keep UI stable until we apply the pending intent.
          if (cap.capability === 'onoff' && typeof this.pendingAutoPollOnOff === 'boolean') {
            return;
          }
          this.setCapabilityValue(cap.capability, cap.fromDevice(capabilities[key]));
          if (cap.capability === 'onoff' && !this.suppressLastStateStore) {
            this.setStoreValue('last_onoff', !!cap.fromDevice(capabilities[key])).catch(this.error);
          }
        });
      });
    }
  }

  registerCapabilities(): void {
    this.capabilityMap.forEach(capability => {
      this.registerCapabilityListener(capability.capability, async value => {
        if (capability.capability === 'onoff') {
          if (!this.suppressLastStateStore) {
            this.setStoreValue('last_onoff', !!value).catch(this.error);
          }

          // If the device is offline and both Auto-Poll and Smart Mode are OFF,
          // preserve original heszi behaviour (device stays controllable/available)
          // BUT avoid immediate set() calls that cause fast timeouts/flashing UI.
          // Instead: keep the button state "active" and retry a poll until the
          // device is reachable, then apply the desired on/off state.
          const autoPoll = !!this.getSetting('auto_poll');
          const smartMode = !!this.getSetting('smart_polling');
          // Treat as offline if we are in an offline session OR if the Tuya socket is not connected.
          const offline = this.wasDisconnected || !!this.offlineStartedAt || this.disconnectedDebounced || !(this.device && (this.device as any).isConnected && (this.device as any).isConnected());

          // Mode 1 (Auto-Poll ON, Smart Mode OFF): if user presses while offline/connecting,
          // do not attempt a direct capability write (would timeout). Instead, remember the desired
          // state and apply it once the device is back online. Auto-Poll will handle the reconnect.
          const mode1 = autoPoll && !smartMode;
          if (mode1 && offline) {
            // Mode 1 should behave like Mode 0 (UX), but Auto-Poll does the reconnect.
            // We remember the desired state, show a short hint, and trigger an immediate poll
            // (single-flight, won't conflict with scheduled Auto-Poll).
            this.pendingAutoPollOnOff = !!value;

            // Reflect UI intent immediately without touching the device while offline/connecting.
            this.setCapabilityValue('onoff', !!value).catch(this.error);

            // Mark offline session so "Device connected" can trigger on the first successful poll.
            if (!this.offlineSince) {
              this.offlineSince = Date.now();
              this.connectedShownThisSession = false;
            }

            // Show hint (do not throw into Homey UI)
            try {
              const hint = 'Poll starting, please wait…';
              this.transientWarningText = hint;
              this.transientWarningLockUntil = Date.now() + 2500;
              await this.setWarning(hint);
              this.homey.setTimeout(() => {
                this.unsetWarning().catch(() => {});
              }, 2500);
            } catch (_) {}

            // Kick an immediate poll so user doesn't have to wait for a long interval.
            this.scheduleUserTriggeredPoll('mode1_onoff_press');

            return;
          }

          const mode0 = !autoPoll && !smartMode;

          // Mode 0 (Auto-Poll OFF, Smart Mode OFF): do not send capability writes while offline.
          // Instead, start a manual poll-recovery loop and apply desired state once online.
          if (mode0 && offline) {
            // Fire-and-forget: never block the capability listener while offline (prevents red 10s timeouts)
            this.handleOfflineUserOnOff(!!value).catch(this.error);
            return;
          }
        }

        if (capability.local) {
          this.log('setDeviceValue', capability.dp, capability.toDevice(value));
        } else {
          await this.setDeviceValue(capability.dp, capability.toDevice(value));
        }

        // UX: whenever the user toggles the device (independent of Auto-Poll/Smart mode),
        // immediately trigger a refresh poll so Homey UI updates quickly and we can
        // detect connectivity issues right away.
        if (capability.capability === 'onoff') {
          this.scheduleUserTriggeredPoll('user_onoff');
        }
      });
    });
  }

  // ---- Offline user on/off recovery (Auto-Poll OFF, Smart Mode OFF) ----
  private offlineUserOnOffPending = false;
  private offlineUserOnOffDesired: boolean | null = null;
  private offlineUserOnOffTimer: NodeJS.Timeout | null = null;
  private offlineWarningShownThisSession = false;
  private offlinePollCounter = 0;
  private transientWarningLockUntil = 0;
  private transientWarningText: string | null = null;


  private clearOfflineUserOnOffTimer() {
    if (this.offlineUserOnOffTimer) {
      this.homey.clearTimeout(this.offlineUserOnOffTimer);
      this.offlineUserOnOffTimer = null;
    }
  }

  private async handleOfflineUserOnOff(desired: boolean) {
    const socketConnected = !!(this.device && (this.device as any).isConnected && (this.device as any).isConnected());
    const onlineNow = socketConnected && !this.disconnectedDebounced;
    // Pressing again while recovery is active aborts the current attempt.
    // BUT: if we already reconnected, this press should be treated as a normal command.
    if (this.offlineUserOnOffPending) {
      if (onlineNow) {
        this.offlineUserOnOffPending = false;
        this.offlineUserOnOffDesired = null;
        this.clearOfflineUserOnOffTimer();
        this.suppressPowerRestoreOnce = false;
        try {
          await this.setDeviceValue('1', desired);
        } catch (err) {
          this.error('Mode 0: failed to apply on/off after reconnect', err);
        }
        return;
      }
      this.offlineUserOnOffPending = false;
      this.offlineUserOnOffDesired = null;
      this.clearOfflineUserOnOffTimer();
      this.suppressPowerRestoreOnce = false;

      // Stop any background reconnect loops (user explicitly aborted).
      this.stopAutoPoll();
      this.stopUnavailableCountdown();

      // UX: show a short "Poll aborted" hint.
      try {
        const msg = 'Poll aborted';
        this.transientWarningText = msg;
        this.transientWarningLockUntil = Date.now() + 1200;
        await this.setWarning(msg);
        this.homey.setTimeout(() => this.unsetWarning().catch(() => {}), 1500);
      } catch (_) {}

      // Keep UI consistent (do not force device state while offline).
      return;
    }

    this.offlineUserOnOffPending = true;
    if (!this.offlineSince) { this.offlineSince = Date.now(); this.connectedShownThisSession = false; }
    // Manual recovery implies we want a connected banner once we reach the device again.
this.offlineUserOnOffDesired = desired;
    this.clearOfflineUserOnOffTimer();

        this.suppressPowerRestoreOnce = true;
// UX: show a short hint when user starts a manual reconnect in Mode 0.
    // Do not spam; we suppress other connect warnings while this pending flow is active.
    try {
      const hint = 'Poll starting, please wait…';
      this.transientWarningText = hint;
      this.transientWarningLockUntil = Date.now() + 2500;
      await this.setWarning(hint);
      this.homey.setTimeout(() => {
        // Clear our own hint (do not throw if replaced)
        this.unsetWarning().catch(() => {});
      }, 3000);
    } catch (_) {}

    // Keep the button "active" (no flicker) while we try to reach the device.
    this.setCapabilityValue('onoff', desired).catch(this.error);

    const attempt = async () => {
      if (!this.offlineUserOnOffPending || this.offlineUserOnOffDesired === null) return;

      // Try a poll first (no set while offline).
      const ok = await this.pollOnce().catch(() => false);

      if (!ok && !this.offlineSince) this.offlineSince = Date.now();


      // If we are back online, apply the desired state once and finish.
      const online = ok || (this.device && (this.device as any).isConnected && (this.device as any).isConnected());

      if (online) {
        const finalDesired = this.offlineUserOnOffDesired;
        this.offlineUserOnOffPending = false;
        this.offlineUserOnOffDesired = null;
        this.clearOfflineUserOnOffTimer();

              
        this.suppressPowerRestoreOnce = false;
// Re-enable Auto-Poll if the setting is enabled (user-triggered reconnect).
        if (!!this.getSetting('auto_poll')) {
          this.startAutoPoll();
        }

        // Apply desired on/off once (no flapping). Never throw into UI.
        try {
          await this.setDeviceValue(this.getOnOffDpKey(), finalDesired);
        } catch (_) {}
        try {
          await this.setCapabilityValue('onoff', finalDesired);
        } catch (_) {}

        // Ensure the "Poll starting" hint was visible briefly
        
        // We reached the device again: show a visible "Device connected" banner once.
        if (!this.connectedShownThisSession) {
          this.connectedShownThisSession = true;
          try {
            const msg = 'Device connected';
          this.transientWarningText = msg;
          this.transientWarningLockUntil = Date.now() + 2800;
          await this.setWarning(msg);
          this.homey.setTimeout(() => this.unsetWarning().catch(() => {}), 3000);
          } catch (_) {}
        }
const waitMs = this.transientWarningLockUntil - Date.now();
        if (waitMs > 0) await new Promise<void>((resolve) => this.homey.setTimeout(resolve, waitMs));
        return;
      }

      // Still offline: retry in 10 seconds (minimum poll interval safeguard).
      this.offlineUserOnOffTimer = this.homey.setTimeout(() => {
        attempt().catch(this.error);
      }, 10000) as any;
    };
    // One immediate attempt (fire-and-forget; never throw to Homey UI)
    attempt().catch(this.error);
  }

  private userTriggeredPollTimer: NodeJS.Timeout | null = null;
  private lastUserTriggeredPollAt = 0;

  private scheduleUserTriggeredPoll(reason: string) {
    const now = Date.now();
    // Rate-limit to avoid accidental spam (double taps, automations).
    if (now - this.lastUserTriggeredPollAt < 1500) return;
    this.lastUserTriggeredPollAt = now;

    if (this.userTriggeredPollTimer) {
      this.homey.clearTimeout(this.userTriggeredPollTimer);
      this.userTriggeredPollTimer = null;
    }

    // Give the device a short moment to apply the command before refreshing.
    this.userTriggeredPollTimer = this.homey.setTimeout(() => {
      this.pollOnce().catch((e) => {
        // Poll failures are handled by existing offline logic; no additional action needed.
        this.error(`[user poll] ${reason}`, e);
      });
    }, 400);
  }

  private startDisconnectDebounce() {
    this.stopDisconnectDebounce();
    // Debounce short network hiccups. Only treat as disconnected if it lasts a bit.
    this.disconnectDebounceTimer = this.homey.setTimeout(() => {
      this.disconnectedDebounced = true;

      const autoPoll = !!this.getSetting('auto_poll');
      const smartMode = !!this.getSetting('smart_polling');

      if (autoPoll) {
        // Keep reconnect attempts running when the device stays offline.
        this.startAutoPoll();
      }

      // Smart Mode is only effective when Auto-Poll is enabled.
      if (autoPoll && smartMode) {
        // Smart Mode: show countdown and phase banners.
        this.startUnavailableCountdown();
      }

      // Only run any background probing when Auto-Poll is enabled.
      // If Auto-Poll is OFF we preserve the original behavior: no polling at all
      // (except user-triggered poll on power button press).
      if (autoPoll) {
        // Health monitor keeps UI state consistent.
        this.startOnlineHealthMonitor();
      }
    }, 5000);
  }

  private stopDisconnectDebounce() {
    if (this.disconnectDebounceTimer) {
      this.homey.clearTimeout(this.disconnectDebounceTimer);
      this.disconnectDebounceTimer = null;
    }
  }

  private stopOnlineHealthMonitor() {
    if (this.onlineHealthTimer) {
      this.homey.clearInterval(this.onlineHealthTimer as any);
      this.onlineHealthTimer = null;
    }
  }

  private startOnlineHealthMonitor() {
    this.stopOnlineHealthMonitor();

    const autoPoll = !!this.getSetting('auto_poll');
    if (!autoPoll) return; // never probe when Auto-Poll is OFF

    // Background health probing is ONLY active when Auto-Poll is ON.
    // This keeps the UI/availability consistent without any polling when Auto-Poll is OFF.
    const baseMs = 30000;

    const tick = async () => {
      try {
        // Don't probe while already in an offline session or while another poll is running.
        if (this.wasDisconnected || this.pollInFlight) return;
        if (!this.device) return false;

        const now = Date.now();
        const last = this.lastContactAt || 0;
        // If we had any traffic recently, skip.
        if (last && (now - last) < baseMs) return;

        // Lightweight health probe: try a short refresh.
        const ok = await this.connect();
        if (!ok) {
          this.enterOfflineState('health probe connect failed');
          return;
        }

        try {
          await this.withTimeout((this.device as any).refresh(), HEALTH_REFRESH_TIMEOUT_MS, 'health refresh');
          this.lastContactAt = Date.now();
        } catch (e) {
          this.enterOfflineState('health probe refresh failed');
        }
      } catch (e) {
        this.error(e);
      }
    };

    // Run once quickly, then on interval.
    tick().catch(this.error);
    this.onlineHealthTimer = this.homey.setInterval(() => {
      tick().catch(this.error);
    }, baseMs) as any;
  }



  private getBucketBoundsSec(): Array<[number, number]> {
    return [
      [0, 30],
      [30, 60],
      [60, 120],
      [120, 300],
      [300, 600],
      [600, 1200],
      [1200, 2400],
      [2400, 3600],
      [3600, 7200],
      [7200, 14400],
      [14400, 28800],
      [28800, 86400],
    ];
  }


  private async updateSmartSurvival(elapsedSec: number) {
    try {
      const bounds = this.getBucketBoundsSec();
      const prev: any = await this.getStoreValue('smart_hist_v1');
      const counts: number[] = Array.isArray(prev?.counts) ? prev.counts : Array(bounds.length).fill(0);
      const survived: number[] = Array.isArray(prev?.survived) ? prev.survived : Array(bounds.length).fill(0);

      // Mark buckets as "survived" once elapsed exceeds their max. Only count each bucket once per offline session.
      let newIdx = this.lastSurvivalBucketIdx;
      for (let i = this.lastSurvivalBucketIdx + 1; i < bounds.length; i++) {
        const b = bounds[i];
        if (elapsedSec >= b[1]) {
          survived[i] = (survived[i] || 0) + 1;
          newIdx = i;
          continue;
        }
        break;
      }

      if (newIdx !== this.lastSurvivalBucketIdx) {
        this.lastSurvivalBucketIdx = newIdx;
        await this.setStoreValue('smart_hist_v1', { counts, survived });
      }
    } catch (e) {
      this.error(e);
    }
  }

  private async updateSmartHistory(durationSec: number) {
    const bounds = this.getBucketBoundsSec();
    const sec = Math.max(0, Math.min(86400, Math.round(durationSec)));
    let idx = bounds.findIndex(([a, b]) => sec >= a && sec < b);
    if (idx < 0) idx = bounds.length - 1;

    const storeKey = 'smart_hist_v1';
    const prev: any = await this.getStoreValue(storeKey);
    const counts: number[] = Array.isArray(prev?.counts) ? prev.counts : new Array(bounds.length).fill(0);
    const decay = 0.97; // forget old habits slowly
    for (let i = 0; i < counts.length; i++) counts[i] = counts[i] * decay;
    counts[idx] = (counts[idx] || 0) + 1;

    await this.setStoreValue(storeKey, { counts }).catch(this.error);
  }

  private async updateReconnectEwma(durationSec: number) {
    try {
      const sec = Math.max(0, Math.min(86400, Number(durationSec) || 0));
      const prev = await this.getStoreValue('last_reconnect_ewma_sec');
      const alpha = 0.25; // blend factor; higher = adapts faster
      const next = (typeof prev === 'number' && prev > 0)
        ? (prev * (1 - alpha) + sec * alpha)
        : sec;
      this.lastReconnectEwmaSec = next;
      await this.setStoreValue('last_reconnect_ewma_sec', next);
    } catch (e) {
      this.error(e);
    }
  }


  private async computeSmartPollIntervalMs(elapsedSec: number): Promise<number> {
    this.smartPollUsingFallback = false;
    // Phase 1: 0-60s -> 10s
    if (elapsedSec < 60) {
      this.lastSmartPollPhase = 1;
      return 10000;
    }

    // Phase 2 (dynamic length): poll every 15s after the initial burst.
    const minSec = 15;
    let maxSec = 300;
    let phase2EndSec = 180;

    const ewma = await this.getStoreValue('last_reconnect_ewma_sec');

    // Dynamic phase-3 maximum interval based on typical off-duration (EWMA)
    if (typeof ewma === 'number') {
      if (ewma > 21600) maxSec = 900; // > 6h
      else if (ewma > 7200) maxSec = 600; // > 2h
      else maxSec = 300;

      // Also adapt phase-2 length
      if (ewma < 60) phase2EndSec = 120;
      else if (ewma > 120) phase2EndSec = 300;
    }

    this.lastPhase2EndSec = phase2EndSec;

    if (elapsedSec < phase2EndSec) {
      this.lastSmartPollPhase = 2;
      return 15000;
    }

    this.lastSmartPollPhase = 3;

    const bounds = this.getBucketBoundsSec();
    const prev: any = await this.getStoreValue('smart_hist_v1');
    const counts: number[] = Array.isArray(prev?.counts) ? prev.counts : [];
    const survivedCounts: number[] = Array.isArray(prev?.survived) ? prev.survived : [];

    // Not enough data yet -> start at minimum
    const total = counts.reduce((a, b) => a + (b || 0), 0);
    if (!total || total < 3) {
      this.smartPollUsingFallback = true;
      return minSec * 1000;
    }

    // Compute a simple hazard-based expected remaining time.
    // We estimate the probability that the device turns back on within each bucket given it has been off until now.
    let expectedRemaining = 0;
    for (let i = 0; i < bounds.length; i++) {
      const b = bounds[i];
      if (elapsedSec >= b[1]) continue;

      const onCount = counts[i] || 0;
      const survCount = Math.max(1, survivedCounts[i] || 0);
      // Hazard estimate from censored learning: P(turn-on in bucket | survived to bucket)
      const hazard = Math.min(0.95, onCount / survCount);

      const bucketMid = (Math.max(elapsedSec, b[0]) + b[1]) / 2;
      const remaining = Math.max(0, bucketMid - elapsedSec);
      expectedRemaining += hazard * remaining;
    }

    // Translate expected remaining seconds into a polling interval.
    let nextSec = 0;
    if (expectedRemaining <= 30) nextSec = 15;
    else if (expectedRemaining <= 180) nextSec = 20;
    else if (expectedRemaining <= 600) nextSec = 30;
    else if (expectedRemaining <= 1800) nextSec = 60;
    else nextSec = 120;

    // In the first 30 minutes after phase 2 ends, ramp up slowly so we don't jump straight to long intervals.
    let localMaxSec = maxSec;
    if (elapsedSec > phase2EndSec && elapsedSec < (phase2EndSec + 1800)) {
      const t = (elapsedSec - phase2EndSec) / 1800; // 0..1
      const rampMax = 180 + t * (maxSec - 180); // start at 3 minutes
      localMaxSec = Math.min(maxSec, Math.max(180, rampMax));
    }

    nextSec = Math.max(minSec, Math.min(localMaxSec, nextSec));

    // Apply per-device backoff on repeated failures during the current offline session.
    const backoffMult = this.getSmartPollBackoffMultiplier();
    if (backoffMult !== 1) {
      nextSec = Math.round(nextSec * backoffMult);
    }

    // Automatic phase jitter (desync) with hysteresis (enabled when >=4 switch-mode devices, disabled when <=2).
    // Jitter is rolled once per phase per device to keep timing stable.
    const jitterEnabled = await this.isPhaseJitterEnabled();
    if (!jitterEnabled) {
      this.lastJitterPhase = null;
      this.lastPhaseJitterSec = 0;
    } else {
      const phaseNow = this.lastSmartPollPhase || 1;
      if (this.lastJitterPhase !== phaseNow) {
        this.lastJitterPhase = phaseNow;
        let window = 0;
        if (phaseNow === 1) window = 2;
        else if (phaseNow === 2) window = 5;
        else window = 15;
        this.lastPhaseJitterSec = window > 0 ? Math.floor(Math.random() * (window + 1)) : 0;
      }
      nextSec += this.lastPhaseJitterSec;
    }

    // Hard cap to avoid extreme waits if backoff... .
    nextSec = Math.max(minSec, Math.min(3600, nextSec));

    // Track what we *wanted* to do before applying any phase-3 probe logic.
    const plannedSec = nextSec;

    // Phase 3 probes: while waiting on long intervals, do a few random "stichprobe" polls in-between.
    // This helps detect power return earlier without keeping the base interval short all the time.
    // We only schedule probes when the planned interval is long enough to make them useful.
    if (this.lastSmartPollPhase === 3 && this.phase3ProbeLeft > 0) {
      const now = Date.now();
      const planned = nextSec;
      const longEnough = planned >= 60;
      const cooldownOk = (now - this.phase3LastProbeScheduledAt) >= 60 * 1000;
      if (longEnough && cooldownOk) {
        // pick a random time within the first part of the interval (min..min(60, planned-10))
        const upper = Math.min(60, planned - 10);
        if (upper > minSec) {
          const probe = Math.floor(minSec + Math.random() * (upper - minSec));
          nextSec = Math.max(minSec, Math.min(probe, planned));
          this.phase3ProbeLeft -= 1;
          this.phase3LastProbeScheduledAt = now;
        }
      }
    }

    // Cache for UI (countdown banner).
    this.lastPlannedIntervalSec = plannedSec;
    this.lastEffectiveIntervalSec = nextSec;
    this.lastWasProbe = (this.lastSmartPollPhase === 3) && (nextSec !== plannedSec);

    return nextSec * 1000;
  }

  private scheduleNextSmartPoll() {
    this.stopAutoPoll();
    const token = ++this.smartPollToken;

    const enabled = !!this.getSetting('auto_poll');
    if (!enabled) return;

    // Only poll after a real disconnect
    if (!this.wasDisconnected || !this.disconnectedDebounced) return;

    const doPoll = async () => {
      if (token !== this.smartPollToken) return;

      // Global safety cap: do not exceed 120 polls per hour (automatic smart polling only)
      if (!this.enforceSmartPollHourlyCap()) {
        return;
      }
      this.nextSmartPollAt = null;
      await this.pollOnce().catch(this.error);

      if (token !== this.smartPollToken) return;

      // If still disconnected, schedule again using updated elapsed
      if (this.wasDisconnected && this.disconnectedDebounced) {
        const elapsedSec = this.offlineStartedAt ? (Date.now() - this.offlineStartedAt) / 1000 : 0;
        const ms = await this.computeSmartPollIntervalMs(elapsedSec);

        if (token !== this.smartPollToken) return;

        this.armSmartPollCountdown(Date.now() + ms);
        this.switchPollTimeout = this.homey.setTimeout(() => {
          // Show active phase while we are polling
          const phase = this.lastSmartPollPhase || 1;
          const phaseText = phase === 1 ? 'Phase 1' : (phase === 2 ? 'Phase 2 (dynamic ramp)' : 'Phase 3 (adaptive)');
          this.updateSmartPollStatus(`${phaseText} - polling now`).catch(this.error);
          doPoll().catch(this.error);
        }, ms);
      }
    };

    // If smart polling is paused (circuit breaker), wait until the pause expires.
    const pauseMs = Math.max(0, this.smartPollPausedUntil - Date.now());
    if (pauseMs > 0) {
      this.switchPollTimeout = this.homey.setTimeout(() => {
        doPoll().catch(this.error);
      }, pauseMs);
      return;
    }

    // run once immediately
    doPoll().catch(this.error);
  }
  private getPollIntervalMs(): number {
    const raw = this.getSetting('poll_interval');
    const unit = (this.getSetting('poll_interval_unit') || 'seconds');
    const base = Number(raw);
    const sec = unit === 'minutes' ? base * 60 : base;
    // Safety: do not allow very small intervals (CPU + network heavy).
    // Minimum per request: 10 seconds.
    const safe = Number.isFinite(sec) ? Math.max(10, Math.min(3600, sec)) : 30;
    return Math.round(safe * 1000);
  }

        private startAutoPoll() {
    this.stopAutoPoll();
    const enabled = !!this.getSetting('auto_poll');
    if (!enabled) return;

    // Only poll after a real disconnect (e.g. power loss)
    if (!this.wasDisconnected || !this.disconnectedDebounced) return;

    const smart = !!this.getSetting('smart_polling');
    if (smart) {
      // Smart polling runs only once per disconnect session. It is re-armed on the next power loss.
      if (!this.smartPollingArmed) return;
      this.scheduleNextSmartPoll();
      return;
    }

    const interval = this.getPollIntervalMs();
    this.switchPollTimer = setInterval(() => {
      this.pollOnce().catch(this.error);
    }, interval);

    // run once quickly
    this.pollOnce().catch(this.error);
  }

      private stopAutoPoll() {
    this.smartPollToken++;
    if (this.switchPollTimer) {
      clearInterval(this.switchPollTimer);
      this.switchPollTimer = null;
        this.updateSmartPollStatus('Inactive').catch(this.error);
  }
    if (this.switchPollTimeout) {
      this.homey.clearTimeout(this.switchPollTimeout);
    
      this.switchPollTimeout = null;
    }
  }

  private async manualReconnectNow() {
    const now = Date.now();
    if (now - this.lastManualReconnectAt < 15000) {
      // rate limit: not more than once every 15 seconds
      return;
    }
    this.lastManualReconnectAt = now;

    // Manual reconnect should bypass any smart-poll pause.
    this.smartPollPausedUntil = 0;
    this.consecutiveTimeouts = 0;

    // ensure polling logic considers we're trying after an outage/manual trigger
    this.wasDisconnected = true;

    await this.pollOnce();
  }

    private async pollOnce(): Promise<boolean> {
    if (this.pollInFlight) return false;
    this.pollInFlight = true;
    let success = false;
    try {
        // Try to reconnect and refresh state.
        if (!this.device) return false;

        const connected = await this.connect();
        if (!connected) return false;

        // Preserve last known state BEFORE refresh, because after power loss the device may boot in a default state.
        const lastBeforeRefresh = this.wasDisconnected ? await this.getStoreValue('last_onoff') : undefined;
        if (this.wasDisconnected) this.suppressLastStateStore = true;

        try {
          // tuyapi refresh returns latest dps
          const data: any = await this.withTimeout((this.device as any).refresh(), REFRESH_TIMEOUT_MS, 'refresh');
          if (data && data.dps) this.setCapabilitiyValues(data.dps);
          success = true;
          this.lastContactAt = Date.now();
          await this.setAvailable();
          this.stopUnavailableCountdown();
          // Don't clear a transient "Poll starting" hint too early
          if (!this.transientWarningText || Date.now() >= this.transientWarningLockUntil) {
            this.unsetWarning().catch(this.error);
          }

          this.stopDisconnectDebounce();
          this.disconnectedDebounced = false;
          this.suppressLastStateStore = false;

          if (this.wasDisconnected) {
            // Always show "Device connected" once when returning from an offline session.
            try {
              const msg = 'Device connected';
              this.transientWarningText = msg;
              this.transientWarningLockUntil = Date.now() + 2800;
              await this.setWarning(msg);
              this.homey.setTimeout(() => this.unsetWarning().catch(() => {}), 3000);
            } catch (_) {}

            // If user pressed on/off while Auto-Poll was reconnecting, apply that intent once online.
            const hasPendingUser = typeof this.pendingAutoPollOnOff === 'boolean';
            // When user intent exists, it overrides Power Restore for this reconnect.
            let desired: boolean | null = null;
    if (!(hasPendingUser || !!this.suppressPowerRestoreOnce)) {
      desired = await this.handlePowerRestoreAfterReconnect(lastBeforeRefresh);
    }
    this.suppressPowerRestoreOnce = false;
            this.wasDisconnected = false;

            // Apply pending user on/off intent (from Mode 1 press while connecting)
            if (typeof this.pendingAutoPollOnOff === 'boolean') {
              const pending = this.pendingAutoPollOnOff;
              this.pendingAutoPollOnOff = null;
              try {
                await this.setDeviceValue(this.getOnOffDpKey(), pending);
              } catch (_) {}
              try {
                await this.setCapabilityValue('onoff', pending);
              } catch (_) {}
            }
            this.suppressLastStateStore = false;
            (this as any).unsetStoreValue?.('last_onoff_before_disconnect')?.catch(this.error);
            if (typeof desired === 'boolean') {
              this.setStoreValue('last_onoff', desired).catch(this.error);
            }
            // Smart polling learning
            if (this.offlineStartedAt) {
              const durSec = (Date.now() - this.offlineStartedAt) / 1000;
              await this.updateSmartSurvival(durSec);
              await this.updateSmartHistory(durSec);
              // EWMA helps Phase 3 adapt its maximum interval over time.
              await this.updateReconnectEwma(durSec);
            }
            this.offlineStartedAt = null;
this.smartPollingArmed = false;
            this.offlineWarningShownThisSession = false;
            await this.updateSmartPollStatus('Inactive (device online)');
            await this.updateSmartPollLearned();
            await this.updateSmartPollConfidence();
            // Stop polling once we're back online.
            this.stopAutoPoll();
          } else {
            this.suppressLastStateStore = false;
          }
        } catch (err) {
          // If refresh/connect hangs, reset the Tuya instance.
          if (String(err).includes('timeout')) {
            await this.resetTuyaDevice('refresh timeout');
          }
          // ignore other refresh errors, next poll will retry
        }
    } catch (err) {
      // Circuit breaker + recovery on timeouts
      if (this.isTimeoutError(err)) {
        this.consecutiveTimeouts += 1;
        if (this.consecutiveTimeouts >= 3) {
          this.pauseSmartPolling('3 consecutive timeouts');
        }
        await this.resetTuyaDevice('poll timeout');
      }
      // Other errors: keep trying on next poll
    } finally {

      // Update backoff state based on whether this poll attempt succeeded.
      this.noteSmartPollResult(success);
      this.pollInFlight = false;
    }
    return success;
  }
  protected async handlePowerRestoreAfterReconnect(lastBeforeRefresh: any): Promise<boolean | null> {
    const mode = (this.getSetting('power_restore') || 'last') as string;

    let desired: boolean | null = null;

    if (mode === 'on') desired = true;
    if (mode === 'off') desired = false;

    if (mode === 'last') {
      const beforeDisc = await this.getStoreValue('last_onoff_before_disconnect');
      if (typeof beforeDisc === 'boolean') {
        desired = beforeDisc;
      } else if (typeof lastBeforeRefresh === 'boolean') {
        desired = lastBeforeRefresh as boolean;
      } else {
        const last = await this.getStoreValue('last_onoff');
        if (typeof last === 'boolean') {
          desired = last;
        } else {
          const cap = this.getCapabilityValue('onoff');
          if (typeof cap === 'boolean') desired = cap;
        }
      }
    }

    if (desired === null) return null;

    await this.setDeviceValue(this.getOnOffDpKey(), desired);
    await this.setCapabilityValue('onoff', desired);
    return desired;
  }

  private enterOfflineState(source: string) {
    // Preserve the last known state before Homey marks the device as unavailable/offline.
    const last = this.getCapabilityValue('onoff');
    if (typeof last === 'boolean') {
      this.setStoreValue('last_onoff', last).catch(this.error);
      this.setStoreValue('last_onoff_before_disconnect', last).catch(this.error);
    }

    this.wasDisconnected = true;
    this.disconnectedDebounced = false;
    this.offlineStartedAt = Date.now();
        if (!this.offlineSince) { this.offlineSince = Date.now(); this.connectedShownThisSession = false; }
this.lastSurvivalBucketIdx = -1;
    // Reset phase-3 probe budget for this offline session
    this.phase3ProbeLeft = 3;
    this.phase3LastProbeScheduledAt = 0;
    this.smartPollingArmed = true;
    this.updateSmartPollStatus('Armed - waiting to reconnect').catch(this.error);
    // While offline we must not overwrite last-state with any default/boot/off reports.
    this.suppressLastStateStore = true;
    // Debounced: start polling only if the disconnect persists for a few seconds
    this.startDisconnectDebounce();

    const autoPoll = !!this.getSetting('auto_poll');
    // Smart Mode is only effective when Auto-Poll is enabled.
    const smartMode = autoPoll && !!this.getSetting('smart_polling');

    // Always reflect "power is gone" as OFF (but keep dim/color intact).
    // If the user just pressed ON/OFF while offline (Auto-Poll OFF), keep the UI "active"
    // until the first successful poll restores connectivity.
    const keepUserDesired = this.offlineUserOnOffPending && this.offlineUserOnOffDesired !== null;
    this.setCapabilityValue('onoff', keepUserDesired ? this.offlineUserOnOffDesired : false).catch(this.error);

    if (!smartMode) {
      // Smart Mode OFF: keep device controllable/available.
      this.setAvailable().catch(this.error);
      const msg = autoPoll
        ? 'Device is currently not available (Auto-Poll is running)'
        : 'Device is currently not available (Auto-Poll is disabled)';
      // Avoid spamming the banner repeatedly during a single offline session.
      if (!this.offlineWarningShownThisSession) {
        this.setWarning(msg).catch(this.error);
        this.offlineWarningShownThisSession = true;
      }
      // No countdown UI in this mode.
      this.updateSmartPollStatus('Inactive').catch(this.error);
    } else {
      // Smart Mode ON: device is marked unavailable and we show reconnect countdown/phase.
      this.unsetWarning().catch(this.error);
      const msg = 'Reconnecting soon • Phase 1 (burst) • default interval (learning pending)';
      this.setUnavailable(msg).catch(this.error);
      this.updateSmartPollStatus(msg).catch(this.error);
    }
  }

  onConnected() {
    this.lastContactAt = Date.now();
    this.stopDisconnectDebounce();
    this.disconnectedDebounced = false;
    // this.log('Device connected');
  }

  onDisconnected() {
    this.enterOfflineState('disconnected event');
  }
  onError(error: Error) {
    // this.log('Device error:', error);
  }

  onDpRefresh(data: any) {
    this.lastContactAt = Date.now();
    this.setCapabilitiyValues(data.dps);

    // add card to be able to get differenet device keys and values
    if (this.driver.deviceRefreshTriggerCard && data.dps) {
      this.driver.deviceRefreshTriggerCard.trigger(this, { rawJSON: JSON.stringify(data.dps) }, {}).catch(this.error);
    }
  }

  onHeartbeat() {
    this.lastContactAt = Date.now();
    // this.log('Heartbeat received');
  }

  onData(data: any) {
    this.lastContactAt = Date.now();
    this.setCapabilitiyValues(data.dps);
  }

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('MyDevice has been initialized');
    this.settings = this.getSettings();
    this.registerCapabilities();
    this.startAutoPoll();
    this.startOnlineHealthMonitor();

    this.createDevice();
    await this.resumePendingActions().catch(this.error);
    // Initial refresh to populate capabilities and last-state store
    await this.pollOnce().catch(this.error);
      await this.updateSmartPollLearned();
    await this.updateSmartPollConfidence();
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('MyDevice has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }: { oldSettings: any; newSettings: any; changedKeys: string[] }): Promise<string | void> {
    this.log('MyDevice settings where changed');
    // Action-like settings (async, sticky until success; user can cancel by switching OFF)
    if (changedKeys.includes('reconnect_now')) {
      if (newSettings.reconnect_now === true) {
        await this.setStoreValue('pending_reconnect_now', true);
        // Run async (do not block Settings UI)
        this.homey.setTimeout(() => this.startPendingReconnectNow().catch(this.error), 0);
      } else {
        await this.setStoreValue('pending_reconnect_now', false);
        this.stopPendingReconnectNow();
      }
    }

    if (changedKeys.includes('reset_learning')) {
      if (newSettings.reset_learning === true) {
        await this.setStoreValue('pending_reset_learning', true);
        // Run async (do not block Settings UI)
        this.homey.setTimeout(() => this.startPendingResetLearning().catch(this.error), 0);
      } else {
        await this.setStoreValue('pending_reset_learning', false);
        this.stopPendingResetLearning();
      }
    }

    // Action-like settings (behave like "Reconnect now")





    // Ignore internal UI label updates
    const internalKeys = new Set(['smart_poll_status','smart_poll_learned','smart_poll_confidence']);
    if (changedKeys.length >= 1 && changedKeys.every(k => internalKeys.has(k))) return;

            // Manual reconnect (checkbox)
    this.settings = newSettings;
    await this.createDevice();

    // Restart monitors to keep offline detection + UI consistent
    this.stopAutoPoll();
    this.startAutoPoll();
    this.startOnlineHealthMonitor();
  
}

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  private async resumePendingActions() {
    try {
      const pendingReconnect = await this.getStoreValue('pending_reconnect_now');
      if (pendingReconnect) {
        this.homey.setTimeout(() => this.startPendingReconnectNow().catch(this.error), 0);
      }
    } catch (e) {
      this.error(e);
    }

    try {
      const pendingReset = await this.getStoreValue('pending_reset_learning');
      if (pendingReset) {
        this.homey.setTimeout(() => this.startPendingResetLearning().catch(this.error), 0);
      }
    } catch (e) {
      this.error(e);
    }
  }

  private stopPendingReconnectNow() {
    // Cancel immediately (even during wait)
    this.pendingReconnectCancelId += 1;
  }

  private async startPendingReconnectNow() {
    const myId = ++this.pendingReconnectCancelId;

    // Optional: show a short hint when the user manually triggers reconnect via settings
    // (do not spam; only once per activation)
    try {
      await this.setWarning('Poll starting, please wait…');
      this.homey.setTimeout(() => {
        // Don't throw if warning already changed
        this.unsetWarning().catch(() => {});
      }, 2500);
    } catch (_) {}

    while (true) {
      const pending = await this.getStoreValue('pending_reconnect_now');
      if (!pending) return;
      if (myId !== this.pendingReconnectCancelId) return;

      // Try one poll (errors are handled inside pollOnce; we just keep retrying)
      const ok = await this.pollOnce().catch(() => false);

      if (!ok && !this.offlineSince) this.offlineSince = Date.now();


      if (myId !== this.pendingReconnectCancelId) return;

      // Online if we are not in a debounced/offline session anymore
      const online = ok || (this.device && (this.device as any).isConnected && (this.device as any).isConnected());
      if (online) {
        await this.setStoreValue('pending_reconnect_now', false);
        // Toggle back to OFF (user can be outside the settings UI)
        await this.setSettings({ reconnect_now: false }).catch(() => {});
        // Visible feedback
        this.setWarning('Device connected').catch(() => {});
        this.homey.setTimeout(() => this.unsetWarning().catch(() => {}), 3000);
        // Connected banner handled by normal transition logic (poll success path)
        return;
      }

      // Wait and retry (10s safeguard)
      await new Promise<void>((resolve) => this.homey.setTimeout(resolve, 10000));
      if (myId !== this.pendingReconnectCancelId) return;
    }
  }

  private stopPendingResetLearning() {
    this.pendingResetCancelId += 1;
  }

  private async startPendingResetLearning() {
    const myId = ++this.pendingResetCancelId;

    while (true) {
      const pending = await this.getStoreValue('pending_reset_learning');
      if (!pending) return;
      if (myId !== this.pendingResetCancelId) return;

      // Prefer real poll success over internal flags
      const ok = await this.pollOnce().catch(() => false);
      const online = ok || (this.device && (this.device as any).isConnected && (this.device as any).isConnected());

      if (!online) {
        // Device offline: keep waiting; user may leave settings UI
        await new Promise<void>((resolve) => this.homey.setTimeout(resolve, 3000));
        continue;
      }

      // Online: do the reset now
      try {
        await this.resetLearningData();
      } catch (e) {
        // If something fails, keep it pending and retry later
        this.error(e);
        await new Promise<void>((resolve) => this.homey.setTimeout(resolve, 3000));
        continue;
      }

      // Clear pending and toggle back to OFF
      await this.setStoreValue('pending_reset_learning', false);
      await this.setSettings({
        reset_learning: false,
        smart_poll_learned: 'Not learned yet',
        smart_poll_confidence: 'Low (total=0, on=0, survived=0)',
        smart_poll_status: 'Inactive (device online)',
      } as any).catch(() => {});

      return;
    }
  }
  async onRenamed(name: string) {

    this.log('MyDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
    private async resetLearningData() {
    try {
      await this.unsetStoreValue('smart_hist_v1');
      await this.unsetStoreValue('last_reconnect_ewma_sec');

      // Reset runtime tracking
      this.lastSurvivalBucketIdx = -1;
      this.offlineStartedAt = null;
// Stop any countdown immediately
      
    } catch (e) {
      this.error(e);
    }
  }



  private async updateSmartPollLearned() {
    try {
      const ewma = await this.getStoreValue('last_reconnect_ewma_sec');
      if (typeof ewma === 'number' && ewma > 0) {
        const mins = Math.round(ewma / 60);
        const label = mins < 60 ? `${mins} minutes` : `${Math.round(mins / 60)} hours`;
        await this.setSettings({ smart_poll_learned: label } as any);
      } else {
        await this.setSettings({ smart_poll_learned: 'Not learned yet' } as any);
      }
    } catch (e) {
      this.error(e);
    }
  }

    private async updateSmartPollConfidence() {
    try {
      const prev: any = await this.getStoreValue('smart_hist_v1');
      const countsRaw: any[] = Array.isArray(prev?.counts) ? prev.counts : [];
      const survivedRaw: any[] = Array.isArray(prev?.survived) ? prev.survived : [];

      const counts = countsRaw.map(v => Math.max(0, Math.round(Number(v) || 0)));
      const survived = survivedRaw.map(v => Math.max(0, Math.round(Number(v) || 0)));

      // Persist cleaned integers so the UI never shows decimals again
      const dirty =
        countsRaw.some(v => Number(v) !== Math.round(Number(v) || 0)) ||
        survivedRaw.some(v => Number(v) !== Math.round(Number(v) || 0));

      if (dirty) {
        await this.setStoreValue('smart_hist_v1', { counts, survived });
      }

      const onSamples = counts.reduce((a, b) => a + b, 0);
      const survivalSamples = survived.reduce((a, b) => a + b, 0);
      const total = onSamples + survivalSamples;

      // Cache for UI (countdown banner).
      this.lastLearningTotal = total;

      let level = 'Low';
      if (total >= 60) level = 'High';
      else if (total >= 20) level = 'Medium';

      await this.setSettings({
        smart_poll_confidence: `${level} (total=${total}, on=${onSamples}, survived=${survivalSamples})`,
      } as any);
    } catch (e) {
      this.error(e);
    }
  }

  private stopUnavailableCountdown() {
    if (this.smartPollCountdownInterval) {
      this.homey.clearInterval(this.smartPollCountdownInterval as any);
      this.smartPollCountdownInterval = null;
    }
  }

  private startUnavailableCountdown() {
    this.stopUnavailableCountdown();

    const enabled = !!this.getSetting('auto_poll');
    if (!enabled) return;
    if (!this.wasDisconnected || !this.disconnectedDebounced) return;

    const tick = async () => {
      try {
        const phase = this.lastSmartPollPhase || 1;
        const phaseText = phase === 1
          ? 'Phase 1 (burst)'
          : (phase === 2 ? 'Phase 2 (ramp)' : 'Phase 3 (adaptive)');

        const now = Date.now();
        const nextAt = this.nextSmartPollAt;
        const remaining = (typeof nextAt === 'number' && nextAt > now)
          ? Math.ceil((nextAt - now) / 1000)
          : 0;

        const planned = this.lastPlannedIntervalSec;
        const effective = this.lastEffectiveIntervalSec;
        const wasProbe = this.lastWasProbe;

        const intervalText = (typeof planned === 'number' && planned > 0)
          ? (wasProbe && typeof effective === 'number' && effective > 0
            ? `interval ${planned}s (probe ${effective}s)`
            : `interval ${planned}s`)
          : '';

        const learningText = this.smartPollUsingFallback
          ? `default interval (learning ${this.lastLearningTotal}/3)`
          : 'learned interval';

        const probeText = phase === 3
          ? `probes left ${this.phase3ProbeLeft}`
          : '';

        const parts = [
          remaining > 0 ? `Reconnecting in ${remaining}s` : 'Reconnecting soon',
          phaseText,
          intervalText,
          probeText,
          learningText,
        ].filter(Boolean);

        const msg = parts.join(' • ');

        // When Auto-Poll/Smart mode is enabled and the device is unavailable, show the tile as OFF.
        // Otherwise Homey may keep showing the last on/off state even while unavailable.
        try {
          if (this.hasCapability('onoff')) {
            const cur = this.getCapabilityValue('onoff');
            if (cur !== false) {
              await this.setCapabilityValue('onoff', false);
            }
          }
        } catch (e) {
          // Never fail countdown updates due to UI state sync issues.
          this.error(e);
        }

        await this.setUnavailable(msg);
        await this.updateSmartPollStatus(msg);
      } catch (e) {
        this.error(e);
      }
    };

    tick().catch(this.error);

    const phase = this.lastSmartPollPhase || 1;
    const intervalMs = phase === 1 ? 1000 : (phase === 2 ? 5000 : 10000);
    this.smartPollCountdownInterval = this.homey.setInterval(() => {
      tick().catch(this.error);
    }, intervalMs) as any;
  }

  private armSmartPollCountdown(targetAt: number) {
    this.nextSmartPollAt = targetAt;
    // Only show countdown when Auto-Poll/Smart mode is enabled (device list tile)
    this.startUnavailableCountdown();
  }



async onDeleted() {
    this.stopDisconnectDebounce();
    this.log('MyDevice has been deleted');
    this.stopAutoPoll();

    this.deleteDevice();
  }
}