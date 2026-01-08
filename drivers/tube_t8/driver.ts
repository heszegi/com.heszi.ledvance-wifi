import { BaseDriver } from '../../base/driver';

module.exports = class T8TubeDriver extends BaseDriver {
  override discoveryStrategy = this.homey.discovery.getStrategy('ledvance_tube');
};
