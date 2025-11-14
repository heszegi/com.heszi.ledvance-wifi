import { BaseDriver } from '../../base/driver';

module.exports = class BulbDriver extends BaseDriver {
  override discoveryStrategy = this.homey.discovery.getStrategy('ledvance_bulb');
};
