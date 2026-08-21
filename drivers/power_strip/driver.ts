import Homey from 'homey';
import { BaseDriver } from '../../base/driver';

export class PowerStripDriver extends BaseDriver {
    override discoveryStrategy = this.homey.discovery.getStrategy('power_strip');

    socketsTriggerCard!: Homey.FlowCardTriggerDevice;

    override async onInit() {
        super.onInit();

        this.socketsTriggerCard = this.homey.flow.getDeviceTriggerCard('sockets_changed');

        this.homey.flow.getConditionCard('socket_state').registerRunListener(async (args: any) => {
            return args.device.getCapabilityValue(`socket.s${args.socket_number}`);
        });

        this.homey.flow.getActionCard('set_socket').registerRunListener(async (args: any) => {
            args.device.setDeviceValue(args.socket_number.toString(), args.on_off === 'true');
        });
    }
};
module.exports = PowerStripDriver;