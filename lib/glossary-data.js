// 术语库（预置部分）：只收录「译名必须统一、且不存在语境歧义」的条目。
//
// 用途：翻译时把命中的条目作为【术语约束】注入给模型 —— 也就是「这个词必须翻成这个」。
// 因为它是**硬约束**（只要词出现就强制生效），所以收录标准很严：
//
//   ✅ 专业术语：sustainability→可持续性、biodiversity→生物多样性。这些词义项单一，强制没有歧义。
//   ✅ 固定搭配：level off→趋于平稳、account for→占（比例）。词组本身就把语境锁死了。
//   ❌ 熟词僻义：**绝对不要放**。
//      曾经收过 subject→使遭受、state→陈述、present→呈现、will→意志、might→力量、last→持续……
//      但出现就强制，而雅思文章里 these 词绝大多数用的是**常见义**
//      （"the state of" 是状态、"at present" 是现在、"I will" 就是会/将要）。
//      强制僻义的后果是默认配置下译文就被带偏，而且用户看不出是术语库干的。
//      熟词僻义应该由**内置离线词表**用「多义并列」的方式给出（见 dict-data.js），而不是这里。
//
// 想加词条直接改下面的文本（英文|中文，一行一条），改完重新加载扩展生效。
export const GLOSSARY_RAW = `
/* 雅思学术术语：译名要统一，词义单一 */
urbanization|城市化
sustainability|可持续性
biodiversity|生物多样性
ecosystem|生态系统
habitat|栖息地
deforestation|森林砍伐
desertification|荒漠化
emission|排放
renewable energy|可再生能源
fossil fuel|化石燃料
greenhouse gas|温室气体
climate change|气候变化
carbon footprint|碳足迹
infrastructure|基础设施
congestion|（交通）拥堵
subsidy|补贴
legislation|立法
regulation|监管法规
policy framework|政策框架
demographic|人口的
literacy rate|识字率
curriculum|课程体系
tuition fee|学费
vocational training|职业培训
cognitive|认知的
hypothesis|假设
correlation|相关性
causation|因果关系
empirical|实证的
methodology|研究方法
questionnaire|调查问卷
respondent|受访者
sampling|抽样
validity|有效性
reliability|可靠性
limitation|局限性
counterargument|对立论点
justification|正当理由
implication|（潜在）影响
proportion|比例
percentage|百分比
ratio|比率

/* 小作文图表描述：词组把语境锁死了，可以强制 */
account for|占（比例）
make up|构成
level off|趋于平稳
bottom out|触底
peak at|达到峰值
rise sharply|急剧上升
fall steadily|稳步下降
fluctuate between|在…之间波动
remain stable|保持稳定
slight increase|小幅增长
significant drop|显著下降
marginal change|微小变化
the proportion of|…的比例
the number of|…的数量
compared with|与…相比
over the period|在这一时期

/* 固定搭配：搭配本身就限定了含义，不存在语境歧义 */
subject to|受…影响
object to|反对
give way to|让位于
in the event of|如果发生
by no means|绝不
on the grounds that|理由是
in light of|鉴于
to some extent|在某种程度上
in terms of|就…而言
with regard to|关于
in the long run|从长远来看
a case in point|一个恰当的例证
it is widely believed that|人们普遍认为
there is no denying that|不可否认
`;
