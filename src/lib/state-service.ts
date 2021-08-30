import firebase from 'firebase/app';
import { SyncObject, SyncService } from './sync-service';

interface StateSyncObject extends SyncObject {
    name: string;
    type: string;
    min: number;
    max: number;
    step: number;
    role: string;
    unit: string;
    read: boolean;
    write: boolean;
    states: Record<string, string>;
    value: string;
    lc: number;
}

export class StateSyncService extends SyncService<StateSyncObject> {
    private dbStateQueuesRef: firebase.database.Reference | undefined;
    private stateTypes: Map<string, string> = new Map();
    private stateValues: Map<string, ioBroker.State> = new Map();
    private stateObjects: Map<string, ioBroker.Object> = new Map();

    constructor(
        private adapter: ioBroker.Adapter,
        database: firebase.database.Database,
        uid: string,
        lang: ioBroker.Languages,
    ) {
        super(adapter.log, database, uid, 'state', lang);

        this.adapter.log.info('StateService: initializing');

        this._initMe();
        this.upload();
    }

    private _initMe(): void {
        this.dbStateQueuesRef = this.database.ref(this.uid + '/state/queue');
        this.dbStateQueuesRef.on('child_added', (data) => {
            const id = data.val().id;
            const val = data.val().value;
            this._setState(id, val);
            if (data.ref.key) {
                this.dbStateQueuesRef?.child(data.ref.key).remove();
            }
            this.adapter.log.debug(
                'StateService: new value received for state ' + id + ' value=' + JSON.stringify(data.val()),
            );
        });
    }

    onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
        if (this.idSet.has(id)) {
            if (obj == null) {
                super.deleteObject(id);
                this.stateObjects.delete(id);
            } else {
                const object = this.getStateObject(id, obj);
                super.syncObject(id, object);
                this.stateObjects.set(id, obj);
            }
        }

        if (obj == null || id == null) {
            return;
        }

        if (obj.type === 'enum' && (id.indexOf('enum.rooms.') === 0 || id.indexOf('enum.functions.') === 0)) {
            this.idSet.clear();
            this.stateTypes.clear();
            this.stateValues.clear();
            this.stateObjects.clear();
            this.adapter.log.info('StateService: an anum has changed, start uploading all states');
            this.upload();
        }
    }

    onStateChange(id: string, state: ioBroker.State): void {
        if (this.idSet.has(id)) {
            const tmp = this.getState(state);

            if (
                this.stateValues.has(id) ||
                this.stateValues.get(id)?.val !== tmp.val ||
                state.from.indexOf('system.adapter.iogo') !== -1
            ) {
                const sobj = this.stateObjects.get(id);
                if (sobj) {
                    this.stateValues.set(id, tmp);
                    const obj = this.getStateObject(id, sobj);
                    if (obj === undefined) {
                        this.adapter.log.warn('StateService: state ' + id + ' is unknown. Nothing updated');
                        return;
                    }
                    this.adapter.log.debug('StateService: sent new value for state id ' + id);
                    super.syncValue(id, obj);
                }
            } else {
                this.adapter.log.debug('StateService: no update sent for state id ' + id);
            }
        }
    }

    private upload(): void {
        this.adapter.getForeignObjects('*', 'enum', (err, enums) => {
            for (const id in enums) {
                if (id.indexOf('enum.rooms.') === 0 || id.indexOf('enum.functions.') === 0) {
                    const object = enums[id];
                    for (const key in object.common.members) {
                        this.idSet.add(object.common.members[key]);
                    }
                }
            }

            this.adapter.getForeignObjects('*', 'state', (err, objects) => {
                const tmpList: Map<string, StateSyncObject> = new Map();

                for (const id in objects) {
                    if (this.idSet.has(id)) {
                        this.stateTypes.set(id, objects[id].common.type);
                        this.stateObjects.set(id, objects[id]);
                    }
                }

                this.adapter.getForeignStates('*', (err, states) => {
                    for (const id in states) {
                        if (this.idSet.has(id)) {
                            if (states[id] !== undefined) {
                                const tmp = this.getState(states[id]);
                                if (typeof states[id].val !== this.stateTypes.get(id)) {
                                    this.adapter.log.warn('StateService: value of state ' + id + ' has wrong type');
                                }
                                this.stateValues.set(id, tmp);
                                tmpList.set(id, this.getStateObject(id, this.stateObjects.get(id)!));
                                this.adapter.log.debug('StateService: uploading ' + id);
                            }
                        }
                    }

                    this.adapter.log.info('StateService: uploading ' + tmpList.size + ' states');
                    super.syncObjectList(tmpList);
                });
            });
        });
    }

    destroy(): void {
        this.dbStateQueuesRef?.off();
    }

    private _setState(id: string, val: string): void {
        let newVal: any = val;
        if (this.stateTypes.get(id) == 'number') {
            newVal = parseFloat(val);
        } else if (this.stateTypes.get(id) == 'boolean') {
            newVal = val == 'true';
        }
        if (id.indexOf('iogo.') === 1) {
            this.adapter.setState(id, newVal);
        } else {
            this.adapter.setForeignState(id, newVal);
        }
    }

    private getStateObject(id: string, obj: ioBroker.Object): StateSyncObject {
        const tmp: any = {};
        if (obj.common.min !== undefined && typeof obj.common.min === 'number') {
            tmp.min = parseFloat(obj.common.min.toString());
        }
        if (obj.common.max !== undefined && typeof obj.common.max === 'number') {
            tmp.max = parseFloat(obj.common.max.toString());
        }
        if (obj.common.step !== undefined && typeof obj.common.step === 'number') {
            tmp.step = parseFloat(obj.common.step.toString());
        }
        if (obj.common.states !== undefined) {
            tmp.states = this.statesStr2Obj(obj.common.states);
        }
        tmp.value = this.stateValues.get(id);

        const ret: StateSyncObject = {
            id: id,
            name: obj.common.name.toString(),
            type: obj.common.type,
            min: tmp.min || null,
            max: tmp.max || null,
            step: tmp.step || null,
            role: obj.common.role || 'text',
            unit: obj.common.unit || null,
            read: obj.common.read === true || obj.common.read === 'true',
            write: obj.common.write === true || obj.common.write === 'true',
            states: tmp.states || null,
            value: tmp.value?.val,
            lc: tmp.value?.lc,
            checksum: '',
            ts: 0,
        };

        return ret;
    }

    private statesStr2Obj(states: Record<string, string> | string): Record<string, string> | null {
        if (typeof states == 'string') {
            const arr = states.split(';');
            states = {};
            if (arr.length == 0) {
                return null;
            }
            for (let i = 0; i < arr.length; i++) {
                const ele = arr[i].split(':');
                states[ele[0]] = ele[1];
            }
            return states;
        }
        if (typeof states == 'object') {
            return states;
        }
        return null;
    }

    private getState(state: ioBroker.State): ioBroker.State {
        if (state.val != null) {
            state.val = state.val.toString();
        } else {
            state.val = 'null';
        }
        state.ts = Date.now();

        return state;
    }
}
