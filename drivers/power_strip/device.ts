import { BaseDevice, ICapabilityMap } from '../../base/device';
import { PowerStripDriver } from './driver';

 export class PowerStripDevice extends BaseDevice {
  override driver!: PowerStripDriver;
  override capabilityMap:ICapabilityMap[] = [
    {
      capability: 'onoff',
      dp: '1|2|3',
      toDevice: (value: boolean) => !!value,
      fromDevice: (value: any) => !!value,
    },
    {
      capability: 'socket.s1',
      dp: '1',
      toDevice: (value: boolean) => !!value,
      fromDevice: (value: any) => !!value,
    },
    {
      capability: 'socket.s2',
      dp: '2',
      toDevice: (value: boolean) => !!value,
      fromDevice: (value: any) => !!value,
    },
    {
      capability: 'socket.s3',
      dp: '3',
      toDevice: (value: boolean) => !!value,
      fromDevice: (value: any) => !!value,
    }
  ];

  override async setDeviceValue(key: string, value: any) {
    if(key.includes('|')) {
      key.split('|').map(async (k: string, i: number) => await super.setDeviceValue(k, value));
    } else {
      await super.setDeviceValue(key, value);
    }
  }

  override async setCapabilityValue(capabilityId: string, value: any){
    const ret = await super.setCapabilityValue(capabilityId, value);

    this.driver.socketsTriggerCard.trigger(this, { 
      state1: this.getCapabilityValue('socket.s1'),
      state2: this.getCapabilityValue('socket.s2'),
      state3: this.getCapabilityValue('socket.s3')
    }, {}).catch(this.error);

    return ret;
  }


  override async onInit() {
    super.onInit();
  }
};
module.exports = PowerStripDevice;
