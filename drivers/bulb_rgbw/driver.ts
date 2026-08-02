import { BaseDriver } from '../../base/driver';

module.exports = class BulbRGBWDriver extends BaseDriver {
  override discoveryStrategy = this.homey.discovery.getStrategy('ledvance_bulb_rgbw');
};
