import { BaseDriver } from '../../base/driver';

module.exports = class PanelDriver extends BaseDriver {
  override discoveryStrategy = this.homey.discovery.getStrategy('ledvance_panel');
};
