// Preset routers of the SimpleX network operators (Simplex.Chat.Operators.Presets). Short links to
// these routers omit the router fingerprint, so the full addresses are needed to resolve them.
import { parseServer, type ProtocolServer } from '../smp/server';

const SIMPLEX_ENABLED = [
  'smp://0YuTwO05YJWS8rkjn9eLJDjQhFKvIYd8d4xG8X1blIU=@smp8.simplex.im,beccx4yfxxbvyhqypaavemqurytl6hozr47wfc7uuecacjqdvwpw2xid.onion',
  'smp://SkIkI6EPd2D63F4xFKfHk7I1UGZVNn6k1QWZ5rcyr6w=@smp9.simplex.im,jssqzccmrcws6bhmn77vgmhfjmhwlyr3u7puw4erkyoosywgl67slqqd.onion',
  'smp://6iIcWT_dF2zN_w5xzZEY7HI2Prbh3ldP07YTyDexPjE=@smp10.simplex.im,rb2pbttocvnbrngnwziclp2f4ckjq65kebafws6g4hy22cdaiv5dwjqd.onion',
  'smp://1OwYGt-yqOfe2IyVHhxz3ohqo3aCCMjtB-8wn4X_aoY=@smp11.simplex.im,6ioorbm6i3yxmuoezrhjk6f6qgkc4syabh7m3so74xunb5nzr4pwgfqd.onion',
  'smp://UkMFNAXLXeAAe0beCa4w6X_zp18PwxSaSjY17BKUGXQ=@smp12.simplex.im,ie42b5weq7zdkghocs3mgxdjeuycheeqqmksntj57rmejagmg4eor5yd.onion',
  'smp://enEkec4hlR3UtKx2NMpOUK_K4ZuDxjWBO1d9Y4YXVaA=@smp14.simplex.im,aspkyu2sopsnizbyfabtsicikr2s4r3ti35jogbcekhm3fsoeyjvgrid.onion',
  'smp://h--vW7ZSkXPeOUpfxlFGgauQmXNFOzGoizak7Ult7cw=@smp15.simplex.im,oauu4bgijybyhczbnxtlggo6hiubahmeutaqineuyy23aojpih3dajad.onion',
  'smp://hejn2gVIqNU6xjtGM3OwQeuk8ZEbDXVJXAlnSBJBWUA=@smp16.simplex.im,p3ktngodzi6qrf7w64mmde3syuzrv57y55hxabqcq3l5p6oi7yzze6qd.onion',
  'smp://ZKe4uxF4Z_aLJJOEsC-Y6hSkXgQS5-oc442JQGkyP8M=@smp17.simplex.im,ogtwfxyi3h2h5weftjjpjmxclhb5ugufa5rcyrmg7j4xlch7qsr5nuqd.onion',
  'smp://PtsqghzQKU83kYTlQ1VKg996dW4Cw4x_bvpKmiv8uns=@smp18.simplex.im,lyqpnwbs2zqfr45jqkncwpywpbtq7jrhxnib5qddtr6npjyezuwd3nqd.onion',
  'smp://N_McQS3F9TGoh4ER0QstUf55kGnNSd-wXfNPZ7HukcM=@smp19.simplex.im,i53bbtoqhlc365k6kxzwdp5w3cdt433s7bwh3y32rcbml2vztiyyz5id.onion',
];

const SIMPLEX_DISABLED = [
  'smp://u2dS9sG8nMNURyZwqASV4yROM28Er0luVTx5X1CsMrU=@smp4.simplex.im,o5vmywmrnaxalvz6wi3zicyftgio6psuvyniis6gco6bp6ekl4cqj4id.onion',
  'smp://hpq7_4gGJiilmz5Rf-CswuU5kZGkm_zOIooSw6yALRg=@smp5.simplex.im,jjbyvoemxysm7qxap7m5d5m35jzv5qq6gnlv7s4rsn7tdwwmuqciwpid.onion',
  'smp://PQUV2eL0t7OStZOoAsPEV2QYWt4-xilbakvGUGOItUo=@smp6.simplex.im,bylepyau3ty4czmn77q4fglvperknl4bi2eb2fdy2bh4jxtf32kf73yd.onion',
];

const FLUX = [
  'smp://xQW_ufMkGE20UrTlBl8QqceG1tbuylXhr9VOLPyRJmw=@smp1.simplexonflux.com,qb4yoanyl4p7o33yrknv4rs6qo7ugeb2tu2zo66sbebezs4cpyosarid.onion',
  'smp://LDnWZVlAUInmjmdpQQoIo6FUinRXGe0q3zi5okXDE4s=@smp2.simplexonflux.com,yiqtuh3q4x7hgovkomafsod52wvfjucdljqbbipg5sdssnklgongxbqd.onion',
  'smp://1jne379u7IDJSxAvXbWb_JgoE7iabcslX0LBF22Rej0=@smp3.simplexonflux.com,a5lm4k7ufei66cdck6fy63r4lmkqy3dekmmb7jkfdm5ivi6kfaojshad.onion',
  'smp://xmAmqj75I9mWrUihLUlI0ZuNLXlIwFIlHRq5Pb6cHAU=@smp4.simplexonflux.com,qpcz2axyy66u26hfdd2e23uohcf3y6c36mn7dcuilcgnwjasnrvnxjqd.onion',
  'smp://rWvBYyTamuRCBYb_KAn-nsejg879ndhiTg5Sq3k0xWA=@smp5.simplexonflux.com,4ao347qwiuluyd45xunmii4skjigzuuox53hpdsgbwxqafd4yrticead.onion',
  'smp://PN7-uqLBToqlf1NxHEaiL35lV2vBpXq8Nj8BW11bU48=@smp6.simplexonflux.com,hury6ot3ymebbr2535mlp7gcxzrjpc6oujhtfxcfh2m4fal4xw5fq6qd.onion',
];

const EXTRA = ['smp://8Af90NX2TTkKEJAF1RCg69P_Odg2Z-6_J6DOKUqK3rQ=@smp7.simplex.im,dbxqutskmmbkbrs7ofi7pmopeyhgi5cxbjbh4ummgmep4r6bz4cbrcid.onion'];

const parse = (xs: string[]): ProtocolServer[] => xs.map((s) => parseServer(s).server);

/** routers used to create queues by default */
export const DEFAULT_SMP_SERVERS: ProtocolServer[] = parse(SIMPLEX_ENABLED);

export const FLUX_SMP_SERVERS: ProtocolServer[] = parse(FLUX);

/** all routers whose short links omit the fingerprint */
export const PRESET_SMP_SERVERS: ProtocolServer[] = parse([...SIMPLEX_ENABLED, ...SIMPLEX_DISABLED, ...FLUX, ...EXTRA]);

/** file servers (XFTP) of the SimpleX Chat presets: files are sent through a random one */
export const DEFAULT_XFTP_SERVERS: ProtocolServer[] = parse([
  'xftp://da1aH3nOT-9G8lV7bWamhxpDYdJ1xmW7j3JpGaDR5Ug=@xftp1.simplex.im,blisztokwh6alt5oem45f2eksm2xdowxszmhjesntcyolmhutoon7sid.onion',
  'xftp://5vog2Imy1ExJB_7zDZrkV1KDWi96jYFyy9CL6fndBVw=@xftp2.simplex.im,jk6jybnel5hin2am5omd7g3hyvb4tfkyl7ea4vx5ldi7gpvz5ogqtcqd.onion',
  'xftp://PYa32DdYNFWi0uZZOprWQoQpIk5qyjRJ3EF7bVpbsn8=@xftp3.simplex.im,pqhchr4bpkzef5wra4hnmzvppn5j5mjrpzkh5ixx6mhylnxxd6lmwnad.onion',
  'xftp://k_GgQl40UZVV0Y4BX9ZTyMVqX5ZewcLW0waQIl7AYDE=@xftp4.simplex.im,q2lrjgiyo2efyweksavwxh3dlsrxetaxjztde2x5nateugrtrwzvmdid.onion',
  'xftp://-bIo6o8wuVc4wpZkZD3tH-rCeYaeER_0lz1ffQcSJDs=@xftp5.simplex.im,2kikdbdhlrluburwt6q6rnoxvezcm2ifx2hj463jlunkeftlzm7hf3qd.onion',
  'xftp://6nSvtY9pJn6PXWTAIMNl95E1Kk1vD7FM2TeOA64CFLg=@xftp6.simplex.im,tg3fmu6houq7vfqlsipm2qqzhtpgxesnuydqozx3khojxydhs53sbbyd.onion',
]);

/** the file servers of the other preset operator, known to the apps */
export const FLUX_XFTP_SERVERS: ProtocolServer[] = parse([
  'xftp://92Sctlc09vHl_nAqF2min88zKyjdYJ9mgxRCJns5K2U=@xftp1.simplexonflux.com,apl3pumq3emwqtrztykyyoomdx4dg6ysql5zek2bi3rgznz7ai3odkid.onion',
  'xftp://YBXy4f5zU1CEhnbbCzVWTNVNsaETcAGmYqGNxHntiE8=@xftp2.simplexonflux.com,c5jjecisncnngysah3cz2mppediutfelco4asx65mi75d44njvua3xid.onion',
  'xftp://ARQO74ZSvv2OrulRF3CdgwPz_AMy27r0phtLSq5b664=@xftp3.simplexonflux.com,dc4mohiubvbnsdfqqn7xhlhpqs5u4tjzp7xpz6v6corwvzvqjtaqqiqd.onion',
  'xftp://ub2jmAa9U0uQCy90O-fSUNaYCj6sdhl49Jh3VpNXP58=@xftp4.simplexonflux.com,4qq5pzier3i4yhpuhcrhfbl6j25udc4czoyascrj4yswhodhfwev3nyd.onion',
  'xftp://Rh19D5e4Eez37DEE9hAlXDB3gZa1BdFYJTPgJWPO9OI=@xftp5.simplexonflux.com,q7itltdn32hjmgcqwhow4tay5ijetng3ur32bolssw32fvc5jrwvozad.onion',
  'xftp://0AznwoyfX8Od9T_acp1QeeKtxUi676IBIiQjXVwbdyU=@xftp6.simplexonflux.com,upvzf23ou6nrmaf3qgnhd6cn3d74tvivlmz3p7wdfwq6fhthjrjiiqid.onion',
]);
