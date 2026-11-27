// A coarse view of D1ResultPaging.tla for the full chart (model/D1ResultPagingChart.cfg): what the card is
// doing, not which page. view.mjs keeps page numbers, for bug paths.
const result = (v) => (v.shown === 'agent' ? "Agent's result" : 'Your result')
const reading = (v) =>
  v.fetch.status === 'paging'
    ? ', next rows loading'
    : v.fetch.status === 'sorting'
      ? ', D1 sorting'
      : v.fetch.status === 'failed'
        ? ', read failed'
        : ''

export const title = 'D1 Studio: reading more of a result (coarse)'

// A run in flight is left out of the labels: starting one changes nothing on screen; its landing is an arrow.
export const state = (v) => `${result(v)}${reading(v)}`

export const group = (v) =>
  v.fetch.status === 'paging' || v.fetch.status === 'sorting' ? 'loading' : v.fetch.status === 'failed' ? 'failed' : 'shown'

export const colors = { shown: 'teal', loading: 'blue', failed: 'orange' }

export const step = (action, from, to) => {
  switch (action) {
    case 'YouGoToPage':
      return 'you go to a page'
    case 'YouSort':
      return 'you click the column header'
    case 'YouRun':
      return 'you run SQL'
    case 'YouRevert':
      return null // a reset every state has: back to the agent's result, nothing loading
    case 'RunLands':
      return from.run.sql === 'agent' ? "the agent's SQL, run again, lands" : 'your SQL lands'
    case 'RunFails':
      return 'your run fails'
    case 'TheReadStarts':
      return 'the read goes to D1'
    case 'TheReadLands':
      return from.fetch.status !== to.fetch.status ? 'the rows land' : 'a late reply lands and is ignored'
    case 'TheReadFails':
      return 'the read fails'
    case 'AnAbortedReadEnds':
      return 'an abandoned read ends'
    default:
      return action
  }
}
