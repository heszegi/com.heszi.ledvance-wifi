import { BaseDriver } from '../../base/driver';

module.exports = class TubeT8Driver extends BaseDriver {
  override discoveryStrategy = this.homey.discovery.getStrategy('ledvance_tube_t8');
};
