import { compileScript, compileUnlockScript } from '../scripts/compile.js'
import { Script, Tap, Tx, Address, Signer } from '../libs/tapscript.js'
import { broadcastTransaction }  from '../libs/esplora.js'
// import { BITVM_GRAPH } from '../transactions/graph.js'

const NETWORK = 'signet'
const MIN_FEES = 5000

// TODO set to smallest sendable amount
export const DUST_LIMIT = 500

// This is an unspendable pubkey 
// See https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki#constructing-and-spending-taproot-outputs
const UNSPENDABLE_PUBKEY = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0'


export class Transaction {
    #parent
    #children = []
    #taproot = []
    #tx

    constructor(params, graph, parent){
        this.#parent = parent
        const taproot = this.constructor.taproot(params)
        for(const leaf of taproot){
            this.addLeaf(...leaf)
        }

        const children = graph[this.constructor.name]
        if(!children) 
            return

        for(const ChildTx of children){
            const childTx = new ChildTx(params, graph, this)
            this.#children.push(childTx)
        }
    }

    addLeaf(type, ...args){
        const leaf = new type(this, ...args)
        this.#taproot.push(leaf)
    }

    getLeaf(index){
        return this.#taproot[index]
    }

    tx(){        
        if(!this.#tx)
            this.#tx = Tx.create({
                vin: [{
                    txid: this.parent.outpoint.txid,
                    vout: this.parent.outpoint.vout,
                    prevout: {
                        value: this.parent.outpoint.value,
                        scriptPubKey: this.parent.outputScriptPubKey
                    },
                }],
                vout: [{
                    value: this.parent.outpoint.value - MIN_FEES, // TODO: Set fees here
                    scriptPubKey: this.outputScriptPubKey
                }]
            })
        return this.#tx
    }

    txid(){
        return Tx.util.getTxid(Tx.encode(this.tx()).hex)
    }

    get outpoint(){
        return {
            txid : this.txid(),
            vout : 0,
            value : this.tx().vout[0].value,
        }
    }

    get inputTaptree(){
        return this.#taproot.map(leaf => leaf.encodedLockingScript)
    }

    get outputTaptree(){
        let tree = []
        for(const child of this.#children){
            tree = tree.concat(child.inputTaptree)
        }
        return tree
    }

    get outputScriptPubKey(){
        const tree = this.outputTaptree
        const [tpubkey, _] = Tap.getPubKey(UNSPENDABLE_PUBKEY, { tree })
        const address = Address.p2tr.fromPubKey(tpubkey, NETWORK)
        return Address.toScriptPubKey(address)
    }

    get actor(){
        return this.constructor.ACTOR
    }

    toGraph(graph = {}){
        if(!this.#children.length)
            return graph

        graph[this.txid()] = this.#children

        for(const child of this.#children){
            child.toGraph(graph)
        }
        return graph
    }

    get parent(){
        return this.#parent
    }
}


export class StartTransaction extends Transaction {
    #outpoint

    constructor(params, graph, outpoint){
        super(params, graph, null)
        this.#outpoint = outpoint

        const startAddress = Address.fromScriptPubKey(this.parent.outputScriptPubKey, NETWORK) 
        console.log(`${this.constructor.name} address`, startAddress)
    }

    get parent(){
        const tree = this.inputTaptree
        const [tpubkey, _] = Tap.getPubKey(UNSPENDABLE_PUBKEY, { tree })
        const address = Address.p2tr.fromPubKey(tpubkey, NETWORK)
        const outputScriptPubKey = Address.toScriptPubKey(address)

        return {
            outpoint : this.#outpoint,
            outputScriptPubKey,
            outputTaptree : tree
        }
    }
}

export class EndTransaction extends Transaction {
    #scriptPubKey

    constructor(params, graph, parent){
        super(params, graph, parent)
        this.#scriptPubKey = params[this.constructor.ACTOR].scriptPubKey
    }

    get outputScriptPubKey(){
        return this.#scriptPubKey
    }
}


export class Leaf {

    #lockArgs

    constructor(tx, ...args){
        if(!tx)
            throw Error('Transaction is undefined')
        this.tx = tx
        this.lockingScript = compileScript( this.lock(...args) )
        this.encodedLockingScript = Tap.encodeScript(this.lockingScript)
        this.#lockArgs = args
    }

    async execute(...args){
        const tree = this.tx.parent.outputTaptree
        const target = this.encodedLockingScript
        const [_, cblock] = Tap.getPubKey(UNSPENDABLE_PUBKEY, { tree, target })

        const tx = this.tx.tx() // TODO: cleanup this code smell `tx.tx()`
        const unlockScript = compileUnlockScript(this.unlock(...this.#lockArgs, ...args))
        tx.vin[0].witness = [...unlockScript, this.lockingScript, cblock]
        const txhex = Tx.encode(tx).hex
        console.log(`Executing ${this.tx.constructor.name} ${this.constructor.name}...`)
        const txid = await broadcastTransaction(txhex)
        console.log(`broadcasted Tx: ${txid}`)
    }
}
