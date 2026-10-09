const test = require('node:test');
const assert = require('node:assert/strict');
const { journeyData, journeyDay } = require('../static/journey.js');

test('legacy attempts count toward coverage but never fabricate dated activity', () => {
  const data = journeyData([{ id: 1, progress: { attempts: 6, last_seen: '2025-01-01T12:00:00Z' } }, { id: 2 }]);
  assert.equal(data.total, 2);
  assert.equal(data.explored, 1);
  assert.equal(data.attempts, 6);
  assert.equal(data.undated, 6);
  assert.equal(data.events.length, 0);
  assert.equal(data.legacy.length, 1);
});
test('mixed histories preserve the legacy snapshot and order real attempts', () => {
  const data = journeyData([{ id: 1, progress: { attempts: 8, historical_last_attempt: '2025-01-01T12:00:00Z',
    history: [{ at: '2026-10-10T12:00:00Z', score: 1 }, { at: '2026-10-09T12:00:00Z', score: .5 }] } }]);
  assert.equal(data.events.length, 2);
  assert.equal(data.undated, 6);
  assert.equal(data.legacy.length, 1);
  assert.equal(data.events[0].score, .5);
});
test('empty and invalid dates do not create phantom activity', () => {
  assert.equal(journeyData([]).total, 0);
  const data = journeyData([{ progress: { attempts: 1, last_seen: 'invalid' } }]);
  assert.equal(data.legacy.length, 0);
  assert.equal(data.undated, 1);
});
test('calendar keys use the browser local day', () => {
  const date = new Date(2026, 9, 10, 23, 30);
  assert.equal(journeyDay(date), '2026-10-10');
});

test('calendar aligns 365 local dates into weekday rows and chronological weeks', () => {
  const { journeyCalendarDates } = require('../static/journey.js');
  const dates = journeyCalendarDates(new Date(2026, 9, 10, 23, 30));
  assert.equal(dates.length, 365);
  assert.equal(journeyDay(dates[0].date), '2025-10-11');
  assert.equal(journeyDay(dates.at(-1).date), '2026-10-10');
  assert.equal(new Set(dates.map(d => journeyDay(d.date))).size, 365);
  dates.forEach((d, i) => {
    assert.equal(d.row, (d.date.getDay() + 6) % 7 + 2);
    if (i && d.date.getDay() === 1) assert.equal(d.column, dates[i-1].column + 1);
  });
});
test('calendar includes leap days and crosses local daylight saving boundaries', () => {
  const { journeyCalendarDates } = require('../static/journey.js');
  const leap = journeyCalendarDates(new Date(2024, 2, 10));
  assert.ok(leap.some(d => journeyDay(d.date) === '2024-02-29'));
  const fall = journeyCalendarDates(new Date(2026, 10, 2));
  assert.equal(new Set(fall.map(d => journeyDay(d.date))).size, 365);
  assert.equal(journeyDay(fall.at(-1).date), '2026-11-02');
});
