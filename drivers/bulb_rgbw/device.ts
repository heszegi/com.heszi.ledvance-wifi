import { BaseDevice, ICapabilityMap, TuyaProtocolVersion } from '../../base/device';

enum COLOR_DATA {
  HUE = 0,
  SATURATION = 1,
  BRIGHTNESS = 2,
}

enum LIGHT_MODE {
  TEMPERATURE = 'temperature',
  COLOR = 'color'
}

module.exports = class BulbRGBWDevice extends BaseDevice {
  override tuyaProtocolVersion = TuyaProtocolVersion.V3_5;

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
      toDevice: (value: any) => (value === LIGHT_MODE.TEMPERATURE ? 'white' : 'colour'),
      fromDevice: (value: any) => (value === 'white' ? LIGHT_MODE.TEMPERATURE : LIGHT_MODE.COLOR),
    },
    {
      capability: 'dim',
      dp: '22',
      toDevice: (value: number) => {
        const clamped = Math.max(0.01, value);
        return this.getCapabilityValue('light_mode') === LIGHT_MODE.COLOR
          ? this.toDeviceColorData(COLOR_DATA.BRIGHTNESS, clamped)
          : Math.round(clamped * 1000);
      },
      fromDevice: (value: any) => value / 1000,
    },
    {
      capability: 'light_hue',
      dp: '24',
      toDevice: (value: number) => this.toDeviceColorData(COLOR_DATA.HUE, value, 360),
      fromDevice: (value: string) => this.fromDeviceColorData(COLOR_DATA.HUE, value, 360),
    },
    {
      capability: 'light_saturation',
      dp: '24',
      toDevice: (value: number) => this.toDeviceColorData(COLOR_DATA.SATURATION, value),
      fromDevice: (value: string) => this.fromDeviceColorData(COLOR_DATA.SATURATION, value),
    },
  ];

  currentColorData: string = '000003e803e8';

  splitColorData(colorData: string) {
    return [
      colorData.substring(0, 4),
      colorData.substring(4, 8),
      colorData.substring(8, 12),
    ];
  }

  toDeviceColorData(type: COLOR_DATA, value: number, scale = 1000) {
    const colorData = this.splitColorData(this.currentColorData);
    colorData[type] = Math.round(value * scale).toString(16).padStart(4, '0');
    this.currentColorData = colorData.join('');
    return this.currentColorData;
  }

  fromDeviceColorData(type: COLOR_DATA, value: string, scale = 1000) {
    this.currentColorData = value;
    return parseInt(this.splitColorData(value)[type], 16) / scale;
  }

  override async onInit() {
    this.setCapabilitiyValues({
      '20': false,
      '21': 'white',
      '24': this.currentColorData,
    });

    super.onInit();
  }

  override registerCapabilities(): void {
    this.capabilityMap.forEach(capability => {
      this.registerCapabilityListener(capability.capability, value => {
        const dp = capability.capability === 'dim' && this.getCapabilityValue('light_mode') === LIGHT_MODE.COLOR
          ? '24'
          : capability.dp;
        this.setDeviceValue(dp, capability.toDevice(value));
      });
    });
  }

  override onDisconnected() {
    this.setCapabilitiyValues({ '20': false });
    this.homey.setTimeout(() => this.createDevice(), 5000);
  }
};
