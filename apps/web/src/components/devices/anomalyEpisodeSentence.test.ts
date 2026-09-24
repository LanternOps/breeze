import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatEpisodeSentence,
  formatMetricValue,
  ordinal,
} from './anomalyEpisodeSentence';
import { i18n } from '../../lib/i18n';
import '../../lib/i18n';

const t = i18n.getFixedT('en', 'devices');

describe('formatMetricValue', () => {
  it('formats a percent metric', () => {
    expect(formatMetricValue('cpu_percent', 96.4)).toBe('96.4%');
  });
  it('formats a bps metric in MB/s', () => {
    expect(formatMetricValue('disk_write_bps', 86_000_000)).toBe('86.0 MB/s');
  });
  it('formats a bps metric in KB/s', () => {
    expect(formatMetricValue('bandwidth_out_bps', 200_000)).toBe('200.0 KB/s');
  });
  it('formats an mb metric', () => {
    expect(formatMetricValue('top_process_ram_mb_max', 2355)).toBe('2355 MB');
  });
  it('formats a gb metric', () => {
    expect(formatMetricValue('disk_used_gb', 6.4)).toBe('6.4 GB');
  });
  it('falls back to a plain number', () => {
    expect(formatMetricValue('process_count', 214)).toBe('214');
  });
  it('treats a non-finite value as zero', () => {
    expect(formatMetricValue('cpu_percent', NaN)).toBe('0');
  });
});

describe('formatDuration', () => {
  it('formats minutes under an hour', () => {
    expect(formatDuration(25 * 60, t)).toBe('25 m');
  });
  it('formats hours and minutes', () => {
    expect(formatDuration(80 * 60, t)).toBe('1 h 20 m');
  });
  it('formats an exact hour with no minute remainder', () => {
    expect(formatDuration(3600, t)).toBe('1 h');
  });
  it('formats under a minute', () => {
    expect(formatDuration(40, t)).toBe('<1 m');
  });
});

describe('ordinal', () => {
  it.each([
    [1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'],
    [11, '11th'], [12, '12th'], [13, '13th'], [21, '21st'], [22, '22nd'], [23, '23rd'],
  ])('formats %i as %s', (n, expected) => {
    expect(ordinal(n)).toBe(expected);
  });
});

describe('formatEpisodeSentence', () => {
  it('spike on a plain device_metrics family, range of values', () => {
    const { headline, attributionLine } = formatEpisodeSentence({
      anomalyType: 'spike',
      metricFamily: 'disk_write',
      peakMetricName: 'disk_write_bps',
      rangeMin: 86_000_000,
      rangeMax: 153_000_000,
      peakValue: 153_000_000,
      peakBaselineValue: 6_000_000,
      durationSeconds: 80 * 60,
      attribution: null,
    }, t);
    expect(headline).toBe('Disk write has been 86.0–153.0 MB/s for 1 h 20 m, normally 6.0 MB/s.');
    expect(attributionLine).toBe('Process detail not available for this metric.');
  });

  it('single-bucket range prints one value, not a dash range', () => {
    const { headline } = formatEpisodeSentence({
      anomalyType: 'spike',
      metricFamily: 'cpu',
      peakMetricName: 'cpu_percent',
      rangeMin: 96.4,
      rangeMax: 96.4,
      peakValue: 96.4,
      peakBaselineValue: 42.2,
      durationSeconds: 5 * 60,
      attribution: null,
    }, t);
    expect(headline).toBe('CPU has been 96.4% for 5 m, normally 42.2%.');
  });

  it('network_egress uses the spike template', () => {
    const { headline } = formatEpisodeSentence({
      anomalyType: 'network_egress',
      metricFamily: 'net_out',
      peakMetricName: 'bandwidth_out_bps',
      rangeMin: 1_000_000,
      rangeMax: 1_000_000,
      peakValue: 1_000_000,
      peakBaselineValue: 100_000,
      durationSeconds: 10 * 60,
      attribution: null,
    }, t);
    expect(headline).toBe('Network out has been 1.0 MB/s for 10 m, normally 100.0 KB/s.');
  });

  it('process_runaway on a _max family reads "one process"', () => {
    const { headline } = formatEpisodeSentence({
      anomalyType: 'process_runaway',
      metricFamily: 'process_ram',
      peakMetricName: 'top_process_ram_mb_max',
      rangeMin: 1932.5,
      rangeMax: 2355,
      peakValue: 2355,
      peakBaselineValue: 614,
      durationSeconds: 15 * 60,
      attribution: null,
    }, t);
    expect(headline).toBe('One process reached 2355 MB, normally 614 MB.');
  });

  it('process_runaway on a _sum family reads "top processes together"', () => {
    const { headline } = formatEpisodeSentence({
      anomalyType: 'process_runaway',
      metricFamily: 'process_ram',
      peakMetricName: 'top_process_ram_mb_sum',
      rangeMin: 5200,
      rangeMax: 6500,
      peakValue: 6500,
      peakBaselineValue: 3200,
      durationSeconds: 15 * 60,
      attribution: null,
    }, t);
    expect(headline).toBe('Top processes together used 6500 MB, normally 3200 MB.');
  });

  it('drop', () => {
    const { headline } = formatEpisodeSentence({
      anomalyType: 'drop',
      metricFamily: 'cpu',
      peakMetricName: 'cpu_percent',
      rangeMin: 3,
      rangeMax: 3,
      peakValue: 3,
      peakBaselineValue: 41,
      durationSeconds: 25 * 60,
      attribution: null,
    }, t);
    expect(headline).toBe('CPU dropped to 3.0% for 25 m, normally 41.0%.');
  });

  it('memory_growth', () => {
    const { headline } = formatEpisodeSentence({
      anomalyType: 'memory_growth',
      metricFamily: 'ram_used',
      peakMetricName: 'ram_used_mb',
      rangeMin: 3100,
      rangeMax: 6400,
      peakValue: 6400,
      peakBaselineValue: null,
      durationSeconds: 45 * 60,
      attribution: null,
    }, t);
    expect(headline).toBe('RAM used grew from 3100 MB to 6400 MB over 45 m.');
  });

  it('disk_growth', () => {
    const { headline } = formatEpisodeSentence({
      anomalyType: 'disk_growth',
      metricFamily: 'disk_used',
      peakMetricName: 'disk_used_gb',
      rangeMin: 40,
      rangeMax: 88,
      peakValue: 88,
      peakBaselineValue: null,
      durationSeconds: 3 * 3600,
      attribution: null,
    }, t);
    expect(headline).toBe('Disk used grew from 40.0 GB to 88.0 GB over 3 h.');
  });

  it('attribution line renders the peak snapshot when present', () => {
    const { attributionLine } = formatEpisodeSentence({
      anomalyType: 'process_runaway',
      metricFamily: 'process_ram',
      peakMetricName: 'top_process_ram_mb_max',
      rangeMin: 1932.5,
      rangeMax: 2355,
      peakValue: 2355,
      peakBaselineValue: 614,
      durationSeconds: 15 * 60,
      attribution: {
        opened: { dimension: 'ramMb', processes: [{ name: 'chrome.exe', pid: 1, value: 900 }] },
        peak: {
          dimension: 'ramMb',
          processes: [
            { name: 'chrome.exe', pid: 4120, value: 1932.5 },
            { name: 'MsMpEng.exe', pid: 88, value: 400 },
            { name: 'Teams.exe', pid: 12, value: 300 },
          ],
        },
      },
    }, t);
    expect(attributionLine).toBe(
      'Top by RAM at peak: chrome.exe 1932.5 MB · MsMpEng.exe 400 MB · Teams.exe 300 MB',
    );
  });

  it('attribution line falls back to the opened snapshot when there is no peak snapshot', () => {
    const { attributionLine } = formatEpisodeSentence({
      anomalyType: 'spike',
      metricFamily: 'cpu',
      peakMetricName: 'cpu_percent',
      rangeMin: 96.4,
      rangeMax: 96.4,
      peakValue: 96.4,
      peakBaselineValue: 42.2,
      durationSeconds: 5 * 60,
      attribution: {
        opened: { dimension: 'cpu', processes: [{ name: 'python.exe', pid: 55, value: 88 }] },
      },
    }, t);
    expect(attributionLine).toBe('Top by CPU at peak: python.exe 88%');
  });

  it('attribution line says detail unavailable when the dimension has no processes', () => {
    const { attributionLine } = formatEpisodeSentence({
      anomalyType: 'spike',
      metricFamily: 'disk',
      peakMetricName: 'disk_percent',
      rangeMin: 90,
      rangeMax: 90,
      peakValue: 90,
      peakBaselineValue: 60,
      durationSeconds: 5 * 60,
      attribution: { peak: { dimension: 'diskBps', processes: [] } },
    }, t);
    expect(attributionLine).toBe('Process detail not available for this metric.');
  });

  it('null range (W02 found no member of the peak metric) prints the peak value alone', () => {
    const { headline } = formatEpisodeSentence({
      anomalyType: 'spike',
      metricFamily: 'cpu',
      peakMetricName: 'cpu_percent',
      rangeMin: null,
      rangeMax: null,
      peakValue: 96.4,
      peakBaselineValue: 42.2,
      durationSeconds: 5 * 60,
      attribution: null,
    }, t);
    expect(headline).toBe('CPU has been 96.4% for 5 m, normally 42.2%.');
  });

  it('an unmapped family falls back to its raw name, title-cased', () => {
    const { headline } = formatEpisodeSentence({
      anomalyType: 'spike',
      metricFamily: 'some_future_metric',
      peakMetricName: 'some_future_metric',
      rangeMin: 10,
      rangeMax: 10,
      peakValue: 10,
      peakBaselineValue: 5,
      durationSeconds: 60,
      attribution: null,
    }, t);
    expect(headline).toBe('Some future metric has been 10 for <1 m, normally 5.');
  });
});
