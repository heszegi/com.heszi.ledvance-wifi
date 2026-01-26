import { BaseDriver } from '../../base/driver';

module.exports = class G9Driver extends BaseDriver {
  override discoveryStrategy = this.homey.discovery.getStrategy('ledvance_g9');
};
