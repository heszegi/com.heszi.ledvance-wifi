import { BaseDevice, ICapabilityMap } from '../../base/device';

enum HST {
  HUE = 0,
  SATURATION = 1,
  TEMPERATURE = 2,
}

module.exports = class PanelDevice extends BaseDevice {
  override capabilityMap:ICapabilityMap[] = [
    {
      capability: 'onoff',
      dp: '20',
      toDevice: (value: boolean) => !!value,
      fromDevice: (value: any) => !!value,
    },
    {
      capability: 'light_mode',
      dp: '21',
      toDevice: (value: any) => (value === 'temperature' ? 'white' : 'colour'),
      fromDevice: (value: any) => (value === 'white' ? 'temperature' : 'color'),
    },
    {
      capability: 'dim',
      dp: '22',
      toDevice: (value: number) => value * 1000,
      fromDevice: (value: any) => value / 1000,
    },
    {
      capability: 'light_hue',
      dp: '25',
      toDevice: (value: any) => this.toDeviceHST(HST.HUE, value),
      fromDevice: (value: any) => this.fromDeviceHST(HST.HUE, value),
    },
    {
      capability: 'light_saturation',
      dp: '25',
      toDevice: (value: any) => this.toDeviceHST(HST.SATURATION, value),
      fromDevice: (value: any) => this.fromDeviceHST(HST.SATURATION, value),
    },
    {
      capability: 'light_temperature',
      dp: '25',
      toDevice: (value: any) => this.toDeviceHST(HST.TEMPERATURE, value),
      fromDevice: (value: any) => this.fromDeviceHST(HST.TEMPERATURE, value),
    },
  ];

  currentMode: string = 'temperature'
  currentHST: string = '000000000000';

  private splitToHST(hst: string) {
    const ret = [];
    ret.push(hst.substring(0, 4));
    ret.push(hst.substring(4, 8));
    ret.push(hst.substring(8));
    return ret;
  }

  toDeviceHST(type: HST, value: any) {
    const hst = this.splitToHST(this.currentHST);
    hst[type] = (value * 1000).toString(16).padStart(4, '0');
    this.currentHST = hst.join('');
    return this.currentHST;
  }

  fromDeviceHST(type: HST, value: any) {
    this.currentHST = value;
    const hst = this.splitToHST(this.currentHST);
    return parseInt(hst[type], 10) / 1000;
  }

  fromDeviceMode(value: string) {
    return 
  }

  override async onInit() {
    this.setCapabilitiyValues({
      '20': false,
      '21': this.currentMode,
      '22': 0,
      '25': this.currentHST,
    });

    super.onInit();
  }

  override onDisconnected() {
    this.setCapabilitiyValues({ '20': false });
  }
};
