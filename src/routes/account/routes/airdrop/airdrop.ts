import { BootstrapFormRenderer } from 'resources/bootstrap-form-renderer';
import { SteemEngine } from 'services/steem-engine';
import { autoinject, computedFrom } from 'aurelia-framework';

import steem from 'steem';

import Papa from 'papaparse';
import { ValidationController, ValidationControllerFactory, ValidationRules } from 'aurelia-validation';

const STEEM_ENGINE_OP_ID = 'ssc-mainnet1';
const MAX_PAYLOAD_SIZE = 8192;
const MAX_ACCOUNTS_CHECK = 999;

@autoinject()
export class Airdrop {
    public hasPaidEngFee = false;
    public usersToAirDrop = [];
    public usersNotExisting = [];
    public userConfirmationInProgress = false;
    public airdropInProgress = false;
    public airdropComplete = false;
    public completed: number = 0;
    public fileInput: HTMLInputElement;
    public memoText: string;
    public tokenSymbol: string;
    public activeKey: string = '';
    public step = 1;
    public payloads = [[]];
    public totalInPayload: any = 0.00;
        
    public currentUser: string;
    public currentAmount: number;

    public tokenExists = true;
    public tokenValidationInProgress = false;
    public currentToken;

    public airdropPercentage = 0;
    public controller: ValidationController;
    public renderer;

    public uploadMode = 'file';
    public manualCsv;

    private csvExample = `@inertia,56
@aggroed,21
@yabapmatt,69
@beggars,100
@fdskjflk,232`;

    constructor(private controllerFactory: ValidationControllerFactory, private se: SteemEngine) {
        this.controller = controllerFactory.createForCurrentScope();

        this.renderer = new BootstrapFormRenderer();

        this.controller.addRenderer(this.renderer);
    }

    async goToStep(step: number) {
        const result = await this.controller.validate();

        if (result.valid) {
            if (step === 3) {
                try {
                    this.tokenValidationInProgress = true;
                    
                    const token = await this.se.findToken(this.tokenSymbol);

                    if (token) {
                        this.tokenExists = true;
                        this.currentToken = token;
                    } else {
                        this.tokenExists = false;
                        return;
                    }
                } finally {
                    this.tokenValidationInProgress = false;
                }
            }

            this.step = step;
        }
    }

    async uploadCsv() {
        try {
            const results = this.uploadMode === 'file' ? await parseCsv(this.fileInput.files[0]) as any : await parseCsv(this.manualCsv) as any;

            if (results.data) {
                this.usersToAirDrop = results.data;

                this.userConfirmationInProgress = true;

                let users = [[]];

                this.usersToAirDrop.forEach(user => {
                    const username = user[0].replace('@', '');

                    const lastUserLength = users[users.length - 1].length;

                    if (lastUserLength > MAX_ACCOUNTS_CHECK) {
                        users.push([username]);
                    } else {
                        users[users.length - 1].push(username);
                    }        
                });

                let checkedUsers = [];
                await forEach(users, async (users, index) => {
                    const res = await steem.api.getAccountsAsync(users);

                    for (let user of res) {
                        checkedUsers.push(user.name);
                    }
                });

                this.usersToAirDrop.forEach((user, index) => {
                    if (!checkedUsers.includes(user[0].replace('@', ''))) {
                        this.usersNotExisting.push(user[0]);
                        this.usersToAirDrop.splice(index, 1);
                    }
                });

                this.userConfirmationInProgress = false;

                // All users exist
                if (!this.usersNotExisting.length) {
                    this.step = 2;
                }
            
            }
        } catch (e) {
            console.error(e);
        }
    }

    payFee() {
        // User hasn't already paid a fee
        if (!this.hasPaidEngFee) {
            if (this.currentToken) {
                steem_keychain.requestSendToken(localStorage.getItem('username'), 'steem-eng', '1.000', 'airdrop-fee', 'ENG', response => {
                    if (response.success) {
                        this.hasPaidEngFee = true;
                        this.step = 4;
    
                        localStorage.setItem('airdrop_transaction_id', response.result.id);
                    }
                });
            }
        }
    }

    @computedFrom('usersToAirDrop.length')
    get totalAmountBeingAirdropped() {
        let finalAmount = 0.000;

        this.usersToAirDrop.forEach(user => {
            if (user[1]) {
                finalAmount += parseFloat(user[1].replace(',', '.'));
            }
        });

        return finalAmount.toFixed(this.currentToken.precision);
    }

    async runAirdrop() {
        this.completed = 0;
        this.airdropInProgress = true;

        const validation = await this.controller.validate();

        if (!validation.valid) {
            console.error('One or more required fields were not filled out');
            return;
        }

        for (const user of this.usersToAirDrop) {
            if (user[1]) {
                const username = user[0].replace('@', '');
                const quantity = parseFloat(user[1].replace(',', '.'));
    
                const payload = {
                    contractName:'tokens',
                    contractAction:'issue',
                    contractPayload: {
                        symbol: `${this.tokenSymbol.toUpperCase()}`,
                        to: `${username}`,
                        quantity: `${quantity}`,
                        memo: this.memoText
                    }
                };
    
                const lastPayloadSize = memorySizeOf(this.payloads[this.payloads.length - 1]);
                const payloadSize = memorySizeOf(payload);
    
                if (payloadSize + lastPayloadSize > MAX_PAYLOAD_SIZE) {
                    this.payloads.push([payload]);
                } else {
                    this.payloads[this.payloads.length - 1].push(payload);
                }    
            }    
        }

        const accountsInPayload = [];

        this.payloads.forEach(payload => {
            payload.forEach(data => {
                accountsInPayload.push(data.contractPayload.to);
                this.totalInPayload += parseFloat(data.contractPayload.quantity);
            });
        });
        
        this.totalInPayload = this.totalInPayload.toFixed(this.currentToken.precision);

        for (let payload of this.payloads) {
            const required_auths = [localStorage.getItem('username')];
            const required_posting_auths = [];

            await steem.broadcast.customJsonAsync(this.activeKey, required_auths, required_posting_auths, STEEM_ENGINE_OP_ID, JSON.stringify(payload));
            
            this.completed++;
            this.airdropPercentage = Math.round((this.completed / this.payloads.length) * 100);

            if (this.completed !== (this.payloads.length) && this.completed !== 0) {
                await sleep(3000);
            } else {
                this.airdropInProgress = false;
                this.airdropComplete = true;
                this.airdropPercentage = 100;
            }
        }
    }
}

async function forEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array);
    }
}

async function parseCsv(file) {
    return new Promise((resolve, reject) => {
        Papa.parse(file, {
            complete: results => {
                resolve(results);
            },
            error: err => {
                reject(err);
            }
        });
    });
}

ValidationRules
    .ensure('memoText').required().withMessageKey('memoText')
    .ensure('tokenSymbol').required().withMessageKey('tokenSymbol')
    .when((obj: Airdrop) => obj.step === 2)
    .ensure('activeKey').required().withMessageKey('activeKey')
    .ensure('confirmationText').equals('AIRDROP').withMessageKey('confirmationText')
    .when((obj: Airdrop) => obj.step === 4)
    .on(Airdrop);

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// https://stackoverflow.com/questions/23318037/size-of-json-object-in-kbs-mbs
function memorySizeOf(obj) {
    var bytes = 0;

    function sizeOf(obj) {
        if(obj !== null && obj !== undefined) {
            switch(typeof obj) {
            case 'number':
                bytes += 8;
                break;
            case 'string':
                bytes += obj.length * 2;
                break;
            case 'boolean':
                bytes += 4;
                break;
            case 'object':
                var objClass = Object.prototype.toString.call(obj).slice(8, -1);
                if(objClass === 'Object' || objClass === 'Array') {
                    for(var key in obj) {
                        if(!obj.hasOwnProperty(key)) continue;
                        sizeOf(obj[key]);
                    }
                } else bytes += obj.toString().length * 2;
                break;
            }
        }
        return bytes;
    };

    return sizeOf(obj);
};