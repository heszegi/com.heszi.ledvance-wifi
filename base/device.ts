import Homey from 'homey';
import TuyaDevice, { TuyaDeviceOptions } from 'tuyapi'; // https://codetheweb.github.io/tuyapi/index.html

export interface ICapabilityMap {
  capability: string;
  dp: string;
  toDevice: (value: any) => any;
  fromDevice: (value: any) => any;
}

interface ISettings { [key: string]: boolean | string | number | undefined | null }

export class BaseDevice extends Homey.Device {
  device!: TuyaDevice;
  capabilityMap: ICapabilityMap[] = [];
  settings: ISettings = {};

  deleteDevice() {
    this.log('Remove TuyaDevice');
    if (this.device && this.device.isConnected()) {
      this.device.removeAllListeners();
      this.device.disconnect();
      this.device = null as any;
    }
  }

  async createDevice() {
    this.deleteDevice();
    this.log('Create TuyaDevice');

    if (this.settings.id && this.settings.key && this.settings.ip) {
      try {
        this.device = new TuyaDevice({
          ...this.settings,
          version: '3.3',
        } as TuyaDeviceOptions);
      } catch (error) {
        await this.setUnavailable(this.homey.__('error.device.create_device', {error}));
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
      }
    } else {
      await this.setUnavailable(this.homey.__('error.device.missing_attributes', this.settings))
    }
  }

  async connect() {
    this.unsetWarning();

    if (this.device) {
      if (this.device.isConnected()) return true;

      try {
        await this.device.connect();
        return true;
      } catch (error) {
        this.setWarning(this.homey.__('error.device.fail_to_connect', {device: this.getName()}));
        return false;
      }
    }

    this.setWarning(this.homey.__('error.device.no_device', {device: this.getName()}));
    return false;
  }

  async setDeviceValue(key: string, value: any) {
    if (await this.connect()) {
      try {
        await this.device.set({ dps: parseInt(key, 10), set: value });
      } catch (error) {
        this.setWarning(this.homey.__('error.device.setting_device_value', {key, error}));
        this.log(`Error setting device value for key ${key}:`, error);
      }
    }
  }

  setCapabilitiyValues(capabilities: {[key: string]: any}) {
    if (capabilities) {
      Object.keys(capabilities).forEach(key => {
        const capabilitie = this.capabilityMap.find(cap => cap.dp === key);
        if (capabilitie) {
          this.setCapabilityValue(capabilitie.capability, capabilitie.fromDevice(capabilities[key]));
        }
      });
    }
  }

  registerCapabilities(): void {
    this.capabilityMap.forEach(capability => {
      this.registerCapabilityListener(capability.capability, value => {
        this.setDeviceValue(capability.dp, capability.toDevice(value));
      });
    });
  }

  onConnected() {
    // this.log('Device connected');
  }

  onDisconnected() {
    // this.log('Device disconnected');
  }

  onError(error: Error) {
    // this.log('Device error:', error);
  }

  onDpRefresh(data: any) {
    this.setCapabilitiyValues(data.dps);
  }

  onHeartbeat() {
    // this.log('Heartbeat received');
  }

  onData(data: any) {
    this.setCapabilitiyValues(data.dps);
  }

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('MyDevice has been initialized');
    this.settings = this.getSettings();
    this.registerCapabilities();
    this.createDevice();
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
  async onSettings({ oldSettings, newSettings, changedKeys }: { oldSettings: ISettings; newSettings: ISettings; changedKeys: string[];}): Promise<string | void> {
    this.log('MyDevice settings where changed');
    this.settings = newSettings;
    this.createDevice()
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name: string) {
    this.log('MyDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('MyDevice has been deleted');
    this.deleteDevice();
  }
}
