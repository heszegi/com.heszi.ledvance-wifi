import { BaseDriver } from '../../base/driver';

module.exports = class BulbG9Driver extends BaseDriver {
  override discoveryStrategy = this.homey.discovery.getStrategy('ledvance_bulb_g9');
};
