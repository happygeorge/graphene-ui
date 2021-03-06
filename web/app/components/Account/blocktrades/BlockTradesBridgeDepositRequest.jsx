import React from "react";
import {Link} from "react-router";
import Translate from "react-translate-component";
import FormattedAsset from "../../Utility/FormattedAsset";
import LoadingIndicator from "../../LoadingIndicator";
import ChainStore from "api/ChainStore";
import ChainTypes from "../../Utility/ChainTypes";
import BindToChainState from "../../Utility/BindToChainState";
import Statistics from "../Statistics";
import AccountActions from "actions/AccountActions";
import Icon from "../../Icon/Icon";
import TimeAgo from "../../Utility/TimeAgo";
import HelpContent from "../../Utility/HelpContent";
import WalletDb from "stores/WalletDb";
import AmountSelector from "../../Utility/AmountSelector";
import WithdrawModal from "../../Modal/WithdrawModal";
import Modal from "react-foundation-apps/src/modal";
import Trigger from "react-foundation-apps/src/trigger";
import ZfApi from "react-foundation-apps/src/utils/foundation-api";
import AccountBalance from "../../Account/AccountBalance";
import BalanceComponent from "../../Utility/BalanceComponent";
import RefcodeInput from "../../Forms/RefcodeInput";
import WithdrawModalBlocktrades from "../../Modal/WithdrawModalBlocktrades";
var Post = require("../../Utility/FormPost.js");

@BindToChainState({keep_updating:true})
class BlockTradesBridgeDepositRequest extends React.Component {
    static propTypes = {
        url:               React.PropTypes.string,
        gateway:           React.PropTypes.string,
        bridge_mode:       React.PropTypes.bool,
        deposit_coin_type: React.PropTypes.string,
        deposit_asset_name: React.PropTypes.string,
        deposit_account: React.PropTypes.string,
        receive_coin_type: React.PropTypes.string,
        account: ChainTypes.ChainAccount,
        issuer_account: ChainTypes.ChainAccount,
        deposit_asset: React.PropTypes.string,
        receive_asset: ChainTypes.ChainAsset,
        initial_deposit_input_coin_type: React.PropTypes.string,
        initial_deposit_output_coin_type: React.PropTypes.string,
        initial_deposit_estimated_input_amount: React.PropTypes.string
    };

    constructor(props) {
        super(props);
        this.refresh_interval = 2 * 60 * 1000; // update deposit limit/estimates every two minutes

        this.coin_info_request_states =
        {
            request_in_progress: 0,
            request_complete: 1,
            request_failed: 2 
        };

        this.estimation_directions =
        {
            output_from_input: 0,
            input_from_output: 1
        };

        this.state = 
        { 
            // things that get displayed for deposits
            deposit_input_coin_type: null,
            deposit_output_coin_type: null,
            input_address: null, 
            deposit_estimated_input_amount: this.props.initial_deposit_estimated_input_amount || "1.0",
            deposit_estimated_output_amount: null,
            deposit_limit: null,

            // things that get displayed for deposits
            withdraw_input_coin_type: null,
            withdraw_output_coin_type: null,
            withdraw_estimated_input_amount: this.props.initial_withdraw_estimated_input_amount || "1.0",
            withdraw_estimated_output_amount: null,
            withdraw_limit: null,

            // input address-related
            coin_info_request_state: this.coin_info_request_states.request_in_progress,
            input_address_requests_in_progress: {},

            // estimate-related
            deposit_estimate_direction: this.estimation_directions.output_from_input,

            // deposit limit-related
            deposit_limit_cache: {}, 
            deposit_limit_requests_in_progress: {},

            // generic data from BlockTrades
            coins_by_type: null,
            allowed_mappings_for_deposit: null,
            allowed_mappings_for_withdraw: null
        };
        
        // get basic data from blocktrades

        let coin_types_url = this.props.url + "/coins";
        let coin_types_promise = fetch(coin_types_url, 
                                       {method: 'get', headers: new Headers({"Accept": "application/json"})})
                                 .then(response => response.json());
        
        let wallet_types_url = this.props.url + "/wallets";
        let wallet_types_promise = fetch(wallet_types_url, 
                                         {method: 'get', headers: new Headers({"Accept": "application/json"})})
                                   .then(response => response.json());
        
        let trading_pairs_url = this.props.url + "/trading-pairs";
        let trading_pairs_promise = fetch(trading_pairs_url, 
                                          {method: 'get', headers: new Headers({"Accept": "application/json"})})
                                    .then(response => response.json());

        let active_wallets_url = this.props.url + "/active-wallets";
        let active_wallets_promise = fetch(active_wallets_url, 
                                          {method: 'get', headers: new Headers({"Accept": "application/json"})})
                                    .then(response => response.json());

        Promise.all([coin_types_promise, wallet_types_promise, trading_pairs_promise, active_wallets_promise])
        .then((json_responses) => {
            let [coin_types, wallet_types_reply, trading_pairs, active_wallets] = json_responses;

            // get quick access to coins by their types
            let coins_by_type = {};
            coin_types.forEach(coin_type => coins_by_type[coin_type.coinType] = coin_type);

            // determine which mappings we will display for deposits and withdrawals
            let allowed_mappings_for_deposit = {}; // all non-bts to bts
            let allowed_mappings_for_withdraw = {}; // all bts to non-bts
            trading_pairs.forEach(pair => {
                let input_coin_info = coins_by_type[pair.inputCoinType];
                let output_coin_info = coins_by_type[pair.outputCoinType];

                // filter out pairs where one asset is a backed asset and the other is a backing asset,
                // those pairs rightly belong under the gateway section, not under the bridge section.
                if (input_coin_info.backingCoinType != pair.outputCoinType &&
                    output_coin_info.backingCoinType != pair.inputCoinType)
                {
                    // filter out mappings where one of the wallets is offline
                    if (active_wallets.indexOf(input_coin_info.walletType) != -1 &&
                        active_wallets.indexOf(output_coin_info.walletType) != -1)
                    {
                        if (input_coin_info.walletType != "bitshares2" && 
                            output_coin_info.walletType == "bitshares2")
                        {
                            allowed_mappings_for_deposit[pair.inputCoinType] = allowed_mappings_for_deposit[pair.inputCoinType] || [];
                            allowed_mappings_for_deposit[pair.inputCoinType].push(pair.outputCoinType);
                        }
                        else if (input_coin_info.walletType == "bitshares2" && 
                                 output_coin_info.walletType != "bitshares2")
                        {
                            allowed_mappings_for_withdraw[pair.inputCoinType] = allowed_mappings_for_withdraw[pair.inputCoinType] || [];
                            allowed_mappings_for_withdraw[pair.inputCoinType].push(pair.outputCoinType);
                        }
                    }
                }
            });

            // we can now set the input and output coin types
            let deposit_input_coin_type = null;
            let deposit_output_coin_type = null;
            let allowed_deposit_coin_types = Object.keys(allowed_mappings_for_deposit);

            if (allowed_deposit_coin_types.length)
            {
                if (this.props.initial_deposit_input_coin_type &&
                    this.props.initial_deposit_input_coin_type in allowed_mappings_for_deposit)
                    deposit_input_coin_type = this.props.initial_deposit_input_coin_type;
                else
                    deposit_input_coin_type = allowed_deposit_coin_types[0];
                let output_coin_types_for_this_input = allowed_mappings_for_deposit[deposit_input_coin_type];
                if (this.props.initial_deposit_output_coin_type &&
                    output_coin_types_for_this_input.indexOf(this.props.initial_deposit_output_coin_type) != -1)
                    deposit_output_coin_type = this.props.initial_deposit_output_coin_type;
                else
                    deposit_output_coin_type = output_coin_types_for_this_input[0];
            }
            
            let withdraw_input_coin_type = null;
            let withdraw_output_coin_type = null;
            let allowed_withdraw_coin_types = Object.keys(allowed_mappings_for_withdraw);

            if (allowed_withdraw_coin_types.length)
            {
                if (this.props.initial_withdraw_input_coin_type &&
                    this.props.initial_withdraw_input_coin_type in allowed_mappings_for_withdraw)
                    withdraw_input_coin_type = this.props.initial_withdraw_input_coin_type;
                else
                    withdraw_input_coin_type = allowed_withdraw_coin_types[0];
                let output_coin_types_for_this_input = allowed_mappings_for_withdraw[withdraw_input_coin_type];
                if (this.props.initial_withdraw_output_coin_type &&
                    output_coin_types_for_this_input.indexOf(this.props.initial_withdraw_output_coin_type) != -1)
                    withdraw_output_coin_type = this.props.initial_withdraw_output_coin_type;
                else
                    withdraw_output_coin_type = output_coin_types_for_this_input[0];
            }
            
            let input_address = this.getCachedOrGeneratedInputAddress(deposit_input_coin_type, deposit_output_coin_type);
            let deposit_limit = this.getCachedOrFreshDepositLimit("deposit", deposit_input_coin_type, deposit_output_coin_type);
            let deposit_estimated_output_amount = this.getAndUpdateOutputEstimate("deposit", deposit_input_coin_type, deposit_output_coin_type, this.state.deposit_estimated_input_amount);

            let withdraw_estimated_output_amount = this.getAndUpdateOutputEstimate("withdraw", withdraw_input_coin_type, withdraw_output_coin_type, this.state.deposit_estimated_input_amount);
            let withdraw_limit = this.getCachedOrFreshDepositLimit("withdraw", withdraw_input_coin_type, withdraw_output_coin_type);

            this.setState({
                coin_info_request_state: this.coin_info_request_states.request_complete,
                coins_by_type: coins_by_type,
                allowed_mappings_for_deposit: allowed_mappings_for_deposit,
                allowed_mappings_for_withdraw: allowed_mappings_for_withdraw,
                deposit_input_coin_type: deposit_input_coin_type,
                deposit_output_coin_type: deposit_output_coin_type,
                input_address: input_address,
                deposit_limit: deposit_limit,
                deposit_estimated_output_amount: deposit_estimated_output_amount,
                deposit_estimate_direction: this.estimation_directions.output_from_input,
                withdraw_input_coin_type: withdraw_input_coin_type,
                withdraw_output_coin_type: withdraw_output_coin_type,
                withdraw_limit: withdraw_limit,
                withdraw_estimated_output_amount: withdraw_estimated_output_amount,
                withdraw_estimate_direction: this.estimation_directions.output_from_input,
            });

        })
        .catch((error) => {
            this.setState( {
                coin_info_request_state: this.coin_info_request_states.request_failed,
                coins_by_type: null,
                allowed_mappings_for_deposit: null,
                allowed_mappings_for_withdraw: null
            });
        });
    }


    // functions for periodically updating our deposit limit and estimates
    updateEstimates()
    {
        if (this.state.deposit_input_coin_type && this.state.deposit_output_coin_type)
        {
            // input address won't usually need refreshing unless there was an error
            // generating it last time around
            let new_input_address = this.getCachedOrGeneratedInputAddress(this.state.deposit_input_coin_type, this.state.deposit_output_coin_type);


            let new_deposit_limit = this.getCachedOrFreshDepositLimit("deposit", this.state.deposit_input_coin_type, this.state.deposit_output_coin_type);
            let new_deposit_estimated_input_amount = this.state.deposit_estimated_input_amount;
            let new_deposit_estimated_output_amount = this.state.deposit_estimated_output_amount;

            if (this.state.deposit_estimate_direction == this.estimation_directions.output_from_input)
                new_deposit_estimated_output_amount = this.getAndUpdateOutputEstimate("deposit", this.state.deposit_input_coin_type, this.state.deposit_output_coin_type, new_deposit_estimated_input_amount);
            else
                new_deposit_estimated_input_amount = this.getAndUpdateInputEstimate("deposit", this.state.deposit_input_coin_type, this.state.deposit_output_coin_type, new_deposit_estimated_output_amount);
            

            let new_withdraw_limit = this.getCachedOrFreshDepositLimit("withdraw", this.state.withdraw_input_coin_type, this.state.withdraw_output_coin_type);
            let new_withdraw_estimated_input_amount = this.state.withdraw_estimated_input_amount;
            let new_withdraw_estimated_output_amount = this.state.withdraw_estimated_output_amount;

            if (this.state.withdraw_estimate_direction == this.estimation_directions.output_from_input)
                new_withdraw_estimated_output_amount = this.getAndUpdateOutputEstimate("withdraw", this.state.withdraw_input_coin_type, this.state.withdraw_output_coin_type, new_withdraw_estimated_input_amount);
            else
                new_withdraw_estimated_input_amount = this.getAndUpdateinputEstimate("withdraw", this.state.withdraw_input_coin_type, this.state.withdraw_output_coin_type, new_withdraw_estimated_output_amount);


            this.setState(
            {
                input_address: new_input_address,
                deposit_limit: new_deposit_limit,
                deposit_estimated_input_amount: new_deposit_estimated_input_amount,
                deposit_estimated_output_amount: new_deposit_estimated_output_amount,
                withdraw_limit: new_withdraw_limit,
                withdraw_estimated_input_amount: new_withdraw_estimated_input_amount,
                withdraw_estimated_output_amount: new_withdraw_estimated_output_amount
            });
        }
    }

    componentDidMount()
    {
        this.update_timer = setInterval(this.updateEstimates.bind(this), this.refresh_interval);
    }

    componentWillUnount()
    {
        clearInterval(this.update_timer);
    }
    
    // functions for managing input addresses
    constructSlotInWalletDb(wallet, name, input_coin_type, output_coin_type)
    {
        wallet.deposit_keys = wallet.deposit_keys || {};
        wallet.deposit_keys[name] = wallet.deposit_keys[name] || {};
        wallet.deposit_keys[name][this.props.gateway] = wallet.deposit_keys[name][this.props.gateway] || {};
        wallet.deposit_keys[name][this.props.gateway][input_coin_type] = 
            wallet.deposit_keys[name][this.props.gateway][input_coin_type] || {};
        wallet.deposit_keys[name][this.props.gateway][input_coin_type][output_coin_type] = 
            wallet.deposit_keys[name][this.props.gateway][input_coin_type][output_coin_type] || [];
    }

    getCachedInputAddress(input_coin_type, output_coin_type)  
    {
        let wallet = WalletDb.getWallet();
        let name = this.props.account.get('name');
        this.constructSlotInWalletDb(wallet, name, input_coin_type, output_coin_type);
        if (wallet.deposit_keys[name][this.props.gateway][input_coin_type][output_coin_type].length)
            return wallet.deposit_keys[name][this.props.gateway][input_coin_type][output_coin_type][0];
        return null;
    }

    cacheInputAddress(input_coin_type, output_coin_type, address)
    {
        let wallet = WalletDb.getWallet();
        let name = this.props.account.get('name');
        this.constructSlotInWalletDb(wallet, name, input_coin_type, output_coin_type);
        wallet.deposit_keys[name][this.props.gateway][input_coin_type][output_coin_type].push(address);
        WalletDb._updateWallet();
    }

    getCachedOrGeneratedInputAddress(input_coin_type, output_coin_type)
    {
        // if we already have an address, just return it
        let cached_input_address = this.getCachedInputAddress(input_coin_type, output_coin_type);
        if (cached_input_address)
            return cached_input_address;

        // if we've already asked for this address, return null, it will trigger a refresh when it completes
        this.state.input_address_requests_in_progress[input_coin_type] = this.state.input_address_requests_in_progress[input_coin_type] || {};
        if (this.state.input_address_requests_in_progress[input_coin_type][output_coin_type])
            return null;

        // else, no active request for this mapping, kick one off
        let body = JSON.stringify({ 
            inputCoinType: input_coin_type,
            outputCoinType: output_coin_type, 
            outputAddress: this.props.account.get('name')
        });

        this.state.input_address_requests_in_progress[input_coin_type][output_coin_type] = true;

        fetch(this.props.url + '/simple-api/initiate-trade', {
            method:'post',
            headers: new Headers({"Accept": "application/json", "Content-Type": "application/json"}),
            body: body
        }).then(reply => { reply.json().then( json => {
            console.assert(json.inputCoinType == input_coin_type, "unexpected reply from initiate-trade");
                console.assert(json.outputCoinType == output_coin_type, "unexpected reply from initiate-trade");
                if (json.inputCoinType != input_coin_type ||
                    json.outputCoinType != output_coin_type)
                    throw Error("unexpected reply from initiate-trade");
                this.cacheInputAddress(json.inputCoinType, json.outputCoinType, json.inputAddress);
                delete this.state.input_address_requests_in_progress[input_coin_type][output_coin_type];
                if (this.state.deposit_input_coin_type == json.inputCoinType &&
                    this.state.deposit_output_coin_type == json.outputCoinType)
                    this.setState({input_address: json.inputAddress});
            }, error => {
                delete this.state.input_address_requests_in_progress[input_coin_type][output_coin_type];
                if (this.state.deposit_input_coin_type == input_coin_type &&
                    this.state.deposit_output_coin_type == output_coin_type)
                    this.setState({input_address: "error generating address"});
            }
        )
        }, error => {
            delete this.state.input_address_requests_in_progress[input_coin_type][output_coin_type];
            if (this.state.deposit_input_coin_type == input_coin_type &&
                this.state.deposit_output_coin_type == output_coin_type)
                this.setState({input_address: "error generating address"});
        });
        return null;
    }
    
    // functions for managing deposit limits
    getCachedDepositLimit(input_coin_type, output_coin_type)
    {
        
        this.state.deposit_limit_cache[input_coin_type] = this.state.deposit_limit_cache[input_coin_type] || {};
        if (this.state.deposit_limit_cache[input_coin_type][output_coin_type])
        {
            let deposit_limit_record = this.state.deposit_limit_cache[input_coin_type][output_coin_type];
            let cache_age = new Date() - deposit_limit_record.timestamp;
            if (cache_age < this.refresh_interval)
                return deposit_limit_record;
            delete this.state.deposit_limit_cache[input_coin_type][output_coin_type]; 
        }
        return null;
    }

    cacheDepositLimit(input_coin_type, output_coin_type, deposit_limit_record)
    {
        deposit_limit_record.timestamp = new Date();
        this.state.deposit_limit_cache[input_coin_type] = this.state.deposit_limit_cache[input_coin_type] || {};
        this.state.deposit_limit_cache[input_coin_type][output_coin_type] = deposit_limit_record;
    }

    getCachedOrFreshDepositLimit(deposit_or_withdraw, input_coin_type, output_coin_type)
    {
        let deposit_limit_record = this.getCachedDepositLimit(input_coin_type, output_coin_type);
        if (deposit_limit_record)
            return deposit_limit_record;

        this.state.deposit_limit_requests_in_progress[input_coin_type] = this.state.input_address_requests_in_progress[input_coin_type] || {};
        this.state.deposit_limit_requests_in_progress[input_coin_type][output_coin_type] = true;

        let deposit_limit_url = this.props.url + 
                                "/deposit-limits?inputCoinType=" + encodeURIComponent(input_coin_type) +
                                "&outputCoinType=" + encodeURIComponent(output_coin_type);
        let deposit_limit_promise = fetch(deposit_limit_url, 
                                          {method: 'get', headers: new Headers({"Accept": "application/json"})})
                                    .then(response => response.json());
        deposit_limit_promise.then(reply => {
            console.assert(reply.inputCoinType == input_coin_type &&
                           reply.outputCoinType == output_coin_type, 
                           "unexpected reply from deposit-limits");
            if (reply.inputCoinType != input_coin_type || reply.outputCoinType != output_coin_type)
                throw Error("unexpected reply from deposit-limits");
            let new_deposit_limit_record =
            { 
                timestamp: new Date(),
                limit: reply.depositLimit 
            };
            this.cacheDepositLimit(input_coin_type, output_coin_type, new_deposit_limit_record);
            delete this.state.deposit_limit_requests_in_progress[input_coin_type][output_coin_type];
            if (this.state[deposit_or_withdraw + "_input_coin_type"] == input_coin_type && 
                this.state[deposit_or_withdraw + "_output_coin_type"] == output_coin_type)
                this.setState({[deposit_or_withdraw + "_limit"]: new_deposit_limit_record});
        }, error => {
            delete this.state.deposit_limit_requests_in_progress[input_coin_type][output_coin_type];
        });
        return null;
    }

    getAndUpdateOutputEstimate(deposit_or_withdraw, input_coin_type, output_coin_type, input_amount)
    {
        let estimate_output_url = this.props.url + 
                                "/estimate-output-amount?inputAmount=" + encodeURIComponent(input_amount) +
                                "&inputCoinType=" + encodeURIComponent(input_coin_type) +
                                "&outputCoinType=" + encodeURIComponent(output_coin_type);
        let estimate_output_promise = fetch(estimate_output_url,
                                            {method: 'get', headers: new Headers({"Accept": "application/json"})})
                                      .then(response => response.json());
        estimate_output_promise.then(reply => {
            console.assert(reply.inputCoinType == input_coin_type &&
                           reply.outputCoinType == output_coin_type &&
                           reply.inputAmount == input_amount, 
                           "unexpected reply from estimate-output-amount");
            if (reply.inputCoinType != input_coin_type || 
                reply.outputCoinType != output_coin_type || 
                reply.inputAmount != input_amount)
                throw Error("unexpected reply from estimate-output-amount");
            if (this.state[deposit_or_withdraw + "_input_coin_type"] == input_coin_type && 
                this.state[deposit_or_withdraw + "_output_coin_type"] == output_coin_type &&
                this.state[deposit_or_withdraw + "_estimated_input_amount"] == input_amount &&
                this.state[deposit_or_withdraw + "_estimate_direction"] == this.estimation_directions.output_from_input)
                this.setState({[deposit_or_withdraw + "_estimated_output_amount"]: reply.outputAmount});
        }, error => {
        });

        return null;
    }

    getAndUpdateInputEstimate(deposit_or_withdraw, input_coin_type, output_coin_type, output_amount)
    {
        let estimate_input_url = this.props.url + 
                                "/estimate-input-amount?outputAmount=" + encodeURIComponent(output_amount) +
                                "&inputCoinType=" + encodeURIComponent(input_coin_type) +
                                "&outputCoinType=" + encodeURIComponent(output_coin_type);
        let estimate_input_promise = fetch(estimate_input_url,
                                            {method: 'get', headers: new Headers({"Accept": "application/json"})})
                                      .then(response => response.json());
        estimate_input_promise.then(reply => {
            console.assert(reply.inputCoinType == input_coin_type &&
                           reply.outputCoinType == output_coin_type &&
                           reply.outputAmount == output_amount, 
                           "unexpected reply from estimate-input-amount");
            if (reply.inputCoinType != input_coin_type || 
                reply.outputCoinType != output_coin_type || 
                reply.outputAmount != output_amount)
                throw Error("unexpected reply from estimate-input-amount");
            if (this.state[deposit_or_withdraw + "_input_coin_type"] == input_coin_type && 
                this.state[deposit_or_withdraw + "_output_coin_type"] == output_coin_type &&
                this.state[deposit_or_withdraw + "_estimated_output_amount"] == output_amount &&
                this.state[deposit_or_withdraw + "_estimate_direction"] == this.estimation_directions.input_from_output)
                this.setState({[deposit_or_withdraw + "_estimated_input_amount"]: reply.inputAmount});
        }, error => {
        });

        return null;
    }

    onInputAmountChanged(deposit_or_withdraw, event)
    {
        let new_estimated_input_amount = event.target.value;
        let new_estimated_output_amount = this.getAndUpdateOutputEstimate(deposit_or_withdraw,
                                                                          this.state[deposit_or_withdraw + "_input_coin_type"], 
                                                                          this.state[deposit_or_withdraw + "_output_coin_type"], 
                                                                          new_estimated_input_amount);

        this.setState(
        {
            [deposit_or_withdraw + "_estimated_input_amount"]: new_estimated_input_amount,
            [deposit_or_withdraw + "_estimated_output_amount"]: new_estimated_output_amount,
            [deposit_or_withdraw + "_estimate_direction"]: this.estimation_directions.output_from_input
        });
    }

    onOutputAmountChanged(deposit_or_withdraw, event)
    {
        let new_estimated_output_amount = event.target.value;
        let new_estimated_input_amount = this.getAndUpdateInputEstimate(deposit_or_withdraw, this.state.deposit_input_coin_type, this.state.deposit_output_coin_type, new_estimated_output_amount);

        this.setState(
        {
            deposit_estimated_output_amount: new_estimated_output_amount,
            deposit_estimated_input_amount: new_estimated_input_amount,
            deposit_estimate_direction: this.estimation_directions.input_from_output
        });
    }


    getWithdrawModalId() {
        return "withdraw_asset_" + this.props.issuer_account.get('name') + "_" + this.props.receive_asset.get('symbol');
    }

    onWithdraw() {
        ZfApi.publish(this.getWithdrawModalId(), "open");
    }
    
    onInputCoinTypeChanged(deposit_or_withdraw, event)
    {
        let new_input_coin_type = event.target.value;
        let possible_output_coin_types = this.state["allowed_mappings_for_" + deposit_or_withdraw][new_input_coin_type];
        let new_output_coin_type = possible_output_coin_types[0];
        if (possible_output_coin_types.indexOf(this.state[deposit_or_withdraw + "_output_coin_type"]) != -1)
            new_output_coin_type = this.state[deposit_or_withdraw + "_output_coin_type"];

        let new_input_address = this.state.input_address;
        if (deposit_or_withdraw == "deposit")
            new_input_address = this.getCachedOrGeneratedInputAddress(new_input_coin_type, new_output_coin_type);
        let new_deposit_limit = this.getCachedOrFreshDepositLimit(deposit_or_withdraw, new_input_coin_type, new_output_coin_type);
        let estimated_output_amount = this.getAndUpdateOutputEstimate(deposit_or_withdraw, new_input_coin_type, new_output_coin_type, this.state.deposit_estimated_input_amount);
        
        this.setState(
        {
            [deposit_or_withdraw + "_input_coin_type"]: new_input_coin_type,
            [deposit_or_withdraw + "_output_coin_type"]: new_output_coin_type,
            input_address: new_input_address,
            [deposit_or_withdraw + "_limit"]: new_deposit_limit,
            [deposit_or_withdraw + "_estimated_output_amount"]: estimated_output_amount,
            [deposit_or_withdraw + "_estimate_direction"]: this.estimation_directions.output_from_input
        });
    }
    
    onOutputCoinTypeChanged(deposit_or_withdraw, event)
    {
        let new_output_coin_type = event.target.value;
        let new_input_address = this.state.input_address;
        if (deposit_or_withdraw == "deposit")
            new_input_address = this.getCachedOrGeneratedInputAddress(this.state[deposit_or_withdraw + "_input_coin_type"], new_output_coin_type);
        let new_deposit_limit = this.getCachedOrFreshDepositLimit(deposit_or_withdraw, this.state[deposit_or_withdraw + "_input_coin_type"], new_output_coin_type);
        let estimated_output_amount = this.getAndUpdateOutputEstimate(deposit_or_withdraw, this.state[deposit_or_withdraw + "_input_coin_type"], new_output_coin_type, this.state[deposit_or_withdraw + "_estimated_input_amount"]);
        
        this.setState(
        {
            [deposit_or_withdraw + "_output_coin_type"]: new_output_coin_type,
            input_address: new_input_address,
            [deposit_or_withdraw + "_limit"]: new_deposit_limit,
            [deposit_or_withdraw + "_estimated_output_amount"]: estimated_output_amount,
            [deposit_or_withdraw + "_estimate_direction"]: this.estimation_directions.output_from_input
        });
    }

    render() {
        if( !this.props.account || !this.props.issuer_account || !this.props.receive_asset )
            return  <div></div>;

        let wallet = WalletDb.getWallet();
        let receive_address = this.state.receive_address;
        if( !receive_address )  {
            if( wallet.deposit_keys &&
                wallet.deposit_keys[this.props.gateway] &&
                wallet.deposit_keys[this.props.gateway][this.props.deposit_asset] &&
                wallet.deposit_keys[this.props.gateway][this.props.deposit_asset][this.props.account.get('name')]
            )
            {
                let addresses = wallet.deposit_keys[this.props.gateway][this.props.deposit_asset][this.props.account.get('name')]
                receive_address = addresses[addresses.length-1]
            }
        }
        if( !receive_address ) { this.requestDepositAddress(); }

        let account_balances = this.props.account.get("balances").toJS();
        console.log( "balances: ", account_balances );
        let asset_types = Object.keys(account_balances);

        let balance = "0 " + this.props.receive_asset.get('symbol');
        if (asset_types.length > 0) {
            let current_asset_id = this.props.receive_asset.get('id');
            if( current_asset_id )
                balance = (<span><Translate component="span" content="transfer.available"/>: <BalanceComponent balance={account_balances[current_asset_id]}/></span>)
        }
    
        if (this.state.coin_info_request_state == this.coin_info_request_states.request_failed)
        {
            return  <div>
                        <p>Error connecting to blocktrades.us, please try again later</p>
                    </div>;
        }
        else if (this.state.coin_info_request_state == this.coin_info_request_states.never_requested || 
                 this.state.coin_info_request_state == this.coin_info_request_states.request_in_progress)
        {
            return  <div>
                      <p>Retrieving current trade data from blocktrades.us</p>
                    </div>;
        }
        else
        {
            let withdraw_modal_id = this.getWithdrawModalId();
            let withdraw_asset_symbol = this.state.coins_by_type[this.state.withdraw_input_coin_type].symbol;

            // deposit
            let deposit_input_coin_type_options = [];
            Object.keys(this.state.allowed_mappings_for_deposit).forEach(allowed_deposit_input_coin_type => {
                deposit_input_coin_type_options.push(<option value={allowed_deposit_input_coin_type}>{this.state.coins_by_type[allowed_deposit_input_coin_type].symbol}</option>);
            });
            let deposit_output_coin_type_options = [];
            let deposit_output_coin_types = this.state.allowed_mappings_for_deposit[this.state.deposit_input_coin_type];
            deposit_output_coin_types.forEach(allowed_deposit_output_coin_type => {
                deposit_output_coin_type_options.push(<option value={allowed_deposit_output_coin_type}>{this.state.coins_by_type[allowed_deposit_output_coin_type].symbol}</option>);
            });

            let input_address = this.state.input_address ? this.state.input_address : "unknown";

            let deposit_input_output_estimator_elements = <span></span>;
            let input_style = {width: "10em", display: "inline", color: "inherit", "background-color": "transparent", "font-size": "0.9em", "border-color": "grey"};
            if (this.state.deposit_input_coin_type && this.state.deposit_output_coin_type)
            {
                let estimated_input_amount_text = this.state.deposit_estimated_input_amount || "calculating";
                let estimated_output_amount_text = this.state.deposit_estimated_output_amount || "calculating";

                deposit_input_output_estimator_elements = 
                    <span>
                        <input type="text"
                            value={estimated_input_amount_text}
                            onChange={this.onInputAmountChanged.bind(this, "deposit") } 
                            style={input_style} />
                        {this.state.coins_by_type[this.state.deposit_input_coin_type].symbol}
                        &nbsp;&rarr;&nbsp;
                        <input type="text"
                            value={estimated_output_amount_text}
                            onChange={this.onOutputAmountChanged.bind(this, "deposit") } 
                            style={input_style} />
                        {this.state.coins_by_type[this.state.deposit_output_coin_type].symbol}
                    </span>;

            }

            let deposit_limit_element = <span>...</span>;
            if (this.state.deposit_limit)
            {
                if (this.state.deposit_limit.limit)
                    deposit_limit_element = <span>{this.state.deposit_limit.limit}</span>;
                else
                    deposit_limit_element = <span>no limit</span>;
            }
            
            // withdrawal
            let withdraw_input_coin_type_options = [];
            Object.keys(this.state.allowed_mappings_for_withdraw).forEach(allowed_withdraw_input_coin_type => {
                withdraw_input_coin_type_options.push(<option value={allowed_withdraw_input_coin_type}>{this.state.coins_by_type[allowed_withdraw_input_coin_type].symbol}</option>);
            });
            let withdraw_output_coin_type_options = [];
            let withdraw_output_coin_types = this.state.allowed_mappings_for_withdraw[this.state.withdraw_input_coin_type];
            withdraw_output_coin_types.forEach(allowed_withdraw_output_coin_type => {
                withdraw_output_coin_type_options.push(<option value={allowed_withdraw_output_coin_type}>{this.state.coins_by_type[allowed_withdraw_output_coin_type].symbol}</option>);
            });

            let withdraw_input_output_estimator_elements = <span></span>;
            if (this.state.withdraw_input_coin_type && this.state.withdraw_output_coin_type)
            {
                let estimated_input_amount_text = this.state.withdraw_estimated_input_amount || "calculating";
                let estimated_output_amount_text = this.state.withdraw_estimated_output_amount || "calculating";

                withdraw_input_output_estimator_elements = 
                    <span>
                        <input type="text"
                            value={estimated_input_amount_text}
                            onChange={this.onInputAmountChanged.bind(this, "withdraw") } 
                            style={input_style} />
                        {this.state.coins_by_type[this.state.withdraw_input_coin_type].symbol}
                        &nbsp;&rarr;&nbsp;
                        <input type="text"
                            value={estimated_output_amount_text}
                            onChange={this.onOutputAmountChanged.bind(this, "withdraw") } 
                            style={input_style} />
                        {this.state.coins_by_type[this.state.withdraw_output_coin_type].symbol}
                    </span>;

            }

            let withdraw_limit_element = <span>...</span>;
            if (this.state.withdraw_limit)
            {
                if (this.state.withdraw_limit.limit)
                    withdraw_limit_element = <span>{this.state.withdraw_limit.limit}</span>;
                else
                    withdraw_limit_element = <span>no limit</span>;
            }


            let select_style = {width: "10em", display: "inline", color: "inherit", "background-color": "transparent", "font-size": "0.9em", "border-color": "grey"};
            return  <div>
                        <table className="table">
                            <thead>
                                <tr>
                                    <th style={{width: "25%"}}>Deposit</th>
                                    <th style={{width: "30%"}}>Deposit To</th>
                                    <th style={{width: "30%"}}>Rate</th>
                                    <th style={{width: "15%"}}>Limit</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <td>
                                        <select value={this.state.deposit_input_coin_type} onChange={this.onInputCoinTypeChanged.bind(this, "deposit")} style={select_style}>
                                          {deposit_input_coin_type_options}
                                        </select>
                                        &rarr;
                                        <select value={this.state.deposit_output_coin_type} onChange={this.onOutputCoinTypeChanged.bind(this, "deposit")} style={select_style}>
                                          {deposit_output_coin_type_options}
                                        </select>
                                    </td>
                                    <td>
                                        {input_address}
                                        </td>
                                            <td>
                                        {deposit_input_output_estimator_elements}
                                    </td>
                                    <td>
                                        {deposit_limit_element} {this.state.coins_by_type[this.state.deposit_input_coin_type].symbol}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                        <table className="table">
                            <thead>
                                <tr>
                                    <th style={{width: "25%"}}>Withdraw</th>
                                    <th style={{width: "30%"}}>Withdraw</th>
                                    <th style={{width: "30%"}}>Rate</th>
                                    <th style={{width: "15%"}}>Limit</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <td>
                                        <select value={this.state.withdraw_input_coin_type} onChange={this.onInputCoinTypeChanged.bind(this, "withdraw")} style={select_style}>
                                          {withdraw_input_coin_type_options}
                                        </select>
                                        &rarr;
                                        <select value={this.state.withdraw_output_coin_type} onChange={this.onOutputCoinTypeChanged.bind(this, "withdraw")} style={select_style}>
                                          {withdraw_output_coin_type_options}
                                        </select>
                                    </td>
                                    <td>
                                        <button className={"button outline"} onClick={this.onWithdraw.bind(this)}><Translate content="" /> Withdraw </button>
                                        <Modal id={withdraw_modal_id} overlay={true}>
                                            <Trigger close={withdraw_modal_id}>
                                                <a href="#" className="close-button">&times;</a>
                                            </Trigger>
                                            <br/>
                                            <div className="grid-block vertical">
                                                <WithdrawModalBlocktrades
                                                    account={this.props.account.get('name')}
                                                    issuer={this.props.issuer_account.get('name')}
                                                    asset={this.state.coins_by_type[this.state.withdraw_input_coin_type].symbol}
                                                    output_coin_name={this.state.coins_by_type[this.state.withdraw_output_coin_type].name}
                                                    output_coin_symbol={this.state.coins_by_type[this.state.withdraw_output_coin_type].symbol}
                                                    output_coin_type={this.state.withdraw_output_coin_type}
                                                    modal_id={withdraw_modal_id} />
                                            </div>
                                        </Modal>
                                    </td>
                                    <td>
                                        {withdraw_input_output_estimator_elements}
                                    </td>
                                    <td>
                                        {withdraw_limit_element} {this.state.coins_by_type[this.state.withdraw_input_coin_type].symbol}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>;

        }
    }
}; // BlockTradesBridgeDepositRequest

export default BlockTradesBridgeDepositRequest;
