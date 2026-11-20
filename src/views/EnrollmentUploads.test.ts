/*
 * Author: Gian Mandac
 * Created Date: 20261119
 */
// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EnrollmentView from './EnrollmentView.vue';
import { validApplication } from '@/lib/enrollment/fixtures';

const uploadToSignedUrl = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({ getPublicSupabaseClient: () => ({ storage: { from: () => ({ uploadToSignedUrl }) } }) }));

describe('optional requirement uploads on the enrollment form', () => {
  let wrapper: VueWrapper;
  const fetchMock = vi.fn();
  const captcha = { template: '<button type="button" @click="$emit(\'token\', \'test-token\')">Complete security check</button>', emits: ['token'], methods: { reset() {} } };
  const config = (documentUploads: boolean) => ({ ok: true, json: async () => ({ status: 'open', schoolYear: '2026-2027', periodId: '1', siteKey: 'k', documentUploads }) });

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(config(true));
    uploadToSignedUrl.mockReset().mockResolvedValue({ data: {}, error: null });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals(); });

  async function render() {
    wrapper = mount(EnrollmentView, { attachTo: document.body, global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, EnrollmentCaptcha: captcha } } });
    await flushPromises();
    for (const [key, value] of Object.entries(validApplication)) {
      if (key !== 'schoolYear') await wrapper.get(`#${key}`).setValue(value);
    }
  }
  async function choose(key: string, file: File) {
    const input = wrapper.get(`#file-${key}`);
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    await input.trigger('change');
  }

  it('hides the upload section until uploads are switched on', async () => {
    fetchMock.mockResolvedValueOnce(config(false));
    await render();
    expect(wrapper.find('.upload-section').exists()).toBe(false);
  });

  it('shows one optional slot per document for the selected grade and status', async () => {
    await render();
    expect(wrapper.findAll('.upload-slot label[for^="file-"]:not(.upload-pick)').map((label) => label.attributes('for')))
      .toEqual(['file-psa-birth-certificate', 'file-report-card', 'file-baptismal-certificate', 'file-marriage-certificate', 'file-good-moral']);
    await wrapper.get('#studentStatus').setValue('Old');
    expect(wrapper.findAll('.upload-slot')).toHaveLength(1);
  });

  it('rejects other file types and files over 10 MB in the browser', async () => {
    await render();
    await choose('report-card', new File(['MZ'], 'setup.exe', { type: 'application/x-msdownload' }));
    expect(wrapper.text()).toContain('Upload a PDF, JPG or PNG file.');
    const large = new File(['x'], 'scan.pdf', { type: 'application/pdf' });
    Object.defineProperty(large, 'size', { value: 10 * 1024 * 1024 + 1 });
    await choose('report-card', large);
    expect(wrapper.text()).toContain('10 MB or smaller');
  });

  it('uploads chosen files after saving, then shows what the school received', async () => {
    await render();
    await choose('report-card', new File(['%PDF-1.7'], 'card.pdf', { type: 'application/pdf' }));
    await choose('good-moral', new File(['jpeg'], 'moral.jpg', { type: 'image/jpeg' }));
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(wrapper.text()).toContain('card.pdf');
    await wrapper.get('#confirmation').setValue(true);
    await wrapper.get('#privacyConsent').setValue(true);
    await wrapper.get('#captcha button').trigger('click');
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ reference: 'SNCS-UP', status: 'Pending', message: 'Visit the Registrar.', uploadsUnavailable: false, uploads: [
        { requirement: 'report-card', path: '7/report-card/a.pdf', token: 't1', contentType: 'application/pdf', ticket: 'ticket-1' },
        { requirement: 'good-moral', path: '7/good-moral/b.jpg', token: 't2', contentType: 'image/jpeg', ticket: 'ticket-2' },
      ] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [
        { requirement: 'report-card', ok: true },
        { requirement: 'good-moral', ok: false, message: 'The file is not a valid JPG image.' },
      ] }) });
    await wrapper.get('form').trigger('submit'); await flushPromises();

    const documents = JSON.parse(fetchMock.mock.calls[1][1].body.get('documents'));
    expect(documents).toEqual([
      { requirement: 'report-card', contentType: 'application/pdf', size: 8 },
      { requirement: 'good-moral', contentType: 'image/jpeg', size: 4 },
    ]);
    expect(uploadToSignedUrl).toHaveBeenCalledWith('7/report-card/a.pdf', 't1', expect.any(File), { contentType: 'application/pdf' });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ tickets: ['ticket-1', 'ticket-2'] });
    const results = wrapper.findAll('.upload-result');
    expect(results.map((item) => item.get('.upload-state').text())).toEqual(['Received', 'Not received']);
    expect(results[1].text()).toContain('Bring this document to the Registrar’s Office');
  });

  it('still saves the application when no files are chosen', async () => {
    await render();
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(wrapper.text()).toContain('None. You’ll bring your documents');
    await wrapper.get('#confirmation').setValue(true);
    await wrapper.get('#privacyConsent').setValue(true);
    await wrapper.get('#captcha button').trigger('click');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ reference: 'SNCS-NOFILES', status: 'Pending', message: 'x', uploads: [] }) });
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(wrapper.text()).toContain('SNCS-NOFILES');
    expect(fetchMock.mock.calls[1][1].body.get('documents')).toBeNull();
    expect(uploadToSignedUrl).not.toHaveBeenCalled();
  });
});
