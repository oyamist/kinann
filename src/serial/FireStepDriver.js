(function(exports) {
    const SerialPort = require('serialport');
    const SerialDriver = require('./SerialDriver');
    const MockFireStep = require('./MockFireStep');
    const winston = require('winston');

    class FireStepDriver extends SerialDriver {
        constructor(options = {}) {
            super(options);
            this.state.synced = false;
            this.onResponse = null;
            this.msCommand = options.msCommand || 500;
            this.allowMock = options.allowMock == null ? false : options.allowMock;
            this.position = [];
        }

        static defaultFilter() {
            return {
                manufacturer: /^Arduino/,
            }
        }

        static discover(filter = FireStepDriver.defaultFilter()) {
            return SerialDriver.discover(filter);
        }

        static serialPortOptions() {
            return Object.assign(SerialDriver.serialPortOptions(), {
                baudRate: 19200,
            });
        }

        write(request, msTimeout) {
            var that = this;
            var superWrite = super.write;
            return new Promise((resolve, reject) => {
                try {
                    let asyncWrite = function*() {
                        try {
                            winston.debug(that.logPrefix, "write()", request.trim());
                            that.state.request = request;
                            that.state.response = "(pending)";
                            var sp = that.serialPort;
                            if (that.onResponse) {
                                throw new Error("FireStep command in progress");
                            }
                            yield superWrite.call(that, request, msTimeout)
                                .then(r => asyncWrite.next(r))
                                .catch(e => {throw e});
                            that.onResponse = (line) => resolve(line);
                            setTimeout(() => {
                                if (that.onResponse) {
                                    sp.close();
                                    throw new Error("FireStep request timeout. SerialPort closed");
                                }
                            }, msTimeout);
                        } catch (err) {
                            winston.error(that.logPrefix, "write()", err);
                            reject(err);
                        }
                    }();
                    asyncWrite.next();
                } catch (err) {
                    reject(err);
                }
            });
        }

        onData(line) {
            line = line.trim();
            if (!line.endsWith('}')) {
                winston.warn(this.logPrefix, "incomplete JSON ignored=>", line);
                return;
            }
            winston.info(this.logPrefix, "onData()", line);
            if (!this.state.synced && !line.startsWith('{"s":0') && line.indexOf('"r":{"id"') < 0) {
                winston.info(this.logPrefix, "onData() ignoring", line);
                return;
            }
            var onResponse = this.onResponse;
            if (onResponse) {
                this.state.response = line;
                this.onResponse = null;
                onResponse(line);
            }
        }

        open(filter = FireStepDriver.defaultFilter(), options = FireStepDriver.serialPortOptions()) {
            var that = this;
            var state = this.state;
            var superOpen = super.open;
            return new Promise((resolve, reject) => {
                let async = function*() {
                    try {
                        var sp = yield superOpen.call(that, filter, options)
                            .then(r => async.next(r))
                            .catch(e => {
                                if (that.allowMock) {
                                    that.serialPort = new MockFireStep(null, {
                                        autoOpen: true
                                    });
                                    that.state.serialPath = "MockFireStep";
                                    winston.info(e.message, "=> opening MockFireStep");
                                    async.next(that.serialPort);
                                } else {
                                    async.throw(e);
                                }
                            });
                        sp.on('error', (err) => winston.error(that.logPrefix, "error", err));
                        sp.on('data', (line) => that.onData.call(that, line));
                        state.synced = false;
                        yield setTimeout(() => async.next(true), 1000); // ignore initial FireStep output
                        var line = yield that.write('{"id":""}\n', that.msCommand)
                            .then(r=>async.next(r)).catch(e=>{throw e});
                        state.synced = true;
                        state.id = JSON.parse(line).r.id;
                        var line = yield that.write('{"sys":""}\n', async, that.msCommand)
                            .then(r=>async.next(r)).catch(e=>{throw e});
                        state.sys = JSON.parse(line).r.sys;

                        winston.info(that.logPrefix, "synced", state.id);
                        resolve(sp);
                    } catch (err) {
                        reject(err);
                    }
                }(); // async
                async.next();
            });
        }

        homeRequest(axes = []) {
            var cmd = {
                hom: "",
            };
            if (axes.length) {
                var hom = {};
                axes.forEach((a, i) => {
                    a != null && (hom[i + 1] = Math.round(Number(a)));
                });
                cmd = {
                    hom
                };
            }
            return JSON.stringify(cmd) + "\n";
        }

        moveToRequest(axes = []) {
            var cmd = {
                mov: "",
            };
            if (axes.length) {
                var mov = {};
                axes.forEach((a, i) => {
                    a != null && (mov[i + 1] = Math.round(Number(a)));
                });
                cmd = {
                    mov
                };
            }
            return JSON.stringify(cmd) + "\n";
        }

    } // class FireStepDriver

    module.exports = exports.FireStepDriver = FireStepDriver;
})(typeof exports === "object" ? exports : (exports = {}));
