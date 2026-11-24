import { expect, it } from 'vitest';
import { mapEnrollment } from './enrollment-mapping';
import { validApplication } from '../src/lib/enrollment/fixtures';

it.each([['Full Payment/Cash', 'full_cash'], ['Monthly', 'monthly'], ['Quarterly', 'quarterly'], ['Semi-Annual', 'semi_annual']])('maps %s to the stored payment code %s', (paymentMode, expected) => {
  const result = mapEnrollment({ ...validApplication, paymentMode, studentStatus: 'Returnee', age: '13', status: 'complete', privacyConsentAt: '2000-01-01' }, '9007199254740993');
  expect(result.gradeLevel).toBe('Grade 7');
  expect(result.application).toMatchObject({
    periodId: '9007199254740993', applicantType: 'returnee', paymentMode: expected, strandCode: null,
    lastName: 'Example', houseStreet: '12 Test Street', zipCode: '1630', primaryContactNumber: '09171234567', secondaryContactNumber: null,
  });
  for (const key of ['age', 'schoolYear', 'status', 'privacyConsentAt', 'referenceNo', 'registrarRemarks', 'department']) expect(result.application).not.toHaveProperty(key);
  expect(result.guardians).toEqual([{ relationship: 'guardian', lastName: 'Example', firstName: 'Guardian', middleName: null, suffix: null,
    occupation: null, contactNumber: '09171234567', email: null, messengerAccount: 'Example Guardian' }]);
});
