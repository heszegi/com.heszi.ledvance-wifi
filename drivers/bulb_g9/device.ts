import { BaseDevice, ICapabilityMap, TuyaProtocolVersion } from '../../base/device';

module.exports = class BulbG9Device extends BaseDevice {
  override tuyaProtocolVersion = TuyaProtocolVersion.V3_5;

  override capabilityMap:ICapabilityMap[] = [
    {
      capability: 'onoff',
      dp: '20',
      toDevice: (value: boolean) => !!value,
      fromDevice: (value: any) => !!value,
    },
    {
      capability: 'dim',
      dp: '22',
      toDevice: (value: number) => value * 1000,
      fromDevice: (value: any) => value / 1000,
    },
    {
      capability: 'light_temperature',
      dp: '23',
      toDevice: (value: number) => 1000 - value * 1000,
      fromDevice: (value: any) => 1 - value / 1000,
    },
  ]

  override async onInit() {
    this.setCapabilitiyValues({
      '20': false,
      '22': 0,
      '23': 0,
    });

    super.onInit();
  }

  override onDisconnected() {
    this.setCapabilitiyValues({ '20': false });
  }
};
