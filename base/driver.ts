import Homey, { DiscoveryResult, DiscoveryStrategy } from 'homey';
import { PairSession } from 'homey/lib/Driver';

export interface IDeviceData{
  id: string; // The device MAC address
}
export interface IDeviceSettings{
  mac: string;
  ip: string;
  id?: string;
  key?: string;
}
export interface IDevice {
  name: string;
  data: IDeviceData;
  settings: IDeviceSettings;
}

export class BaseDriver extends Homey.Driver {
  deviceRefreshTriggerCard!: Homey.FlowCardTriggerDevice;
  discoveryStrategy!: DiscoveryStrategy;
  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('MyDriver has been initialized');

    this.deviceRefreshTriggerCard = this.homey.flow.getDeviceTriggerCard('device_refresh');
  }

  async onPair(session: PairSession) {
    let selectedDevices: any;

    session.setHandler('list_devices', async () => {
      /* const devices: any[] = Homey.env.panels;
      this.myDevices.forEach(device => {
        if (device.ip === '') return;
        devices.push({
          name: device.name,
          data: {
            id: device.id,
          },
          settings: {
            mac: device.mac,
            id: device.id,
            key: device.localKey,
            ip: device.ip,
          },
        });
      });
      return devices; */

      const discoveryResults = this.discoveryStrategy.getDiscoveryResults() || {};
      return this.getNewDevices(
        Object.keys(discoveryResults).map(key => {
          const device = discoveryResults[key] as Homey.DiscoveryResultMAC;
          return {
            name: device.mac,
            data: {
              id: device.mac
            },
            settings: {
              mac: device.mac,
              ip: device.address
            },
          } as IDevice;
        })
      );
    });

    session.setHandler('list_devices_selection', async (devices: IDevice[]) => {
      selectedDevices = devices;
    });

    session.setHandler('get_devices', async () => {
      return selectedDevices;
    });

    session.setHandler('get_new_devices', async (devices: IDevice[]) => {
      return this.getNewDevices(devices);
    });
  }

  getNewDevices(discoveredDevices:IDevice[]) {
    const newDevices:IDevice[] = [];
    const pairedDevices = this.getDevices();
    discoveredDevices.forEach(discoveredDevice => {
      for (const key in pairedDevices) {
        const pairedDevice = pairedDevices[key];

        if (discoveredDevice.settings.mac === pairedDevice.getSetting('mac')) {
          discoveredDevice = null as unknown as IDevice;
          break;
        };
      };

      if (discoveredDevice) {
        newDevices.push(discoveredDevice);
      };
    });
    return newDevices;
  }
}
