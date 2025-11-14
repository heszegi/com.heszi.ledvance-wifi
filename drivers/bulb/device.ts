import { BaseDevice, ICapabilityMap } from '../../base/device';

module.exports = class BulbDevice extends BaseDevice {
  override capabilityMap:ICapabilityMap[] = [
    {
      capability: 'onoff',
      dp: '20',
      toDevice: (value: boolean) => value,
      fromDevice: (value: any) => value,
    },
    {
      capability: 'dim',
      dp: '22',
      toDevice: (value: number) => value * 1000,
      fromDevice: (value: any) => value / 1000,
    },
  ]

  override async onInit() {
    this.setCapabilitiyValues({
      '20': false,
      '22': 0,
    });

    super.onInit();
  }

  override onDisconnected() {
    this.setCapabilitiyValues({ '20': false });
  }
};
