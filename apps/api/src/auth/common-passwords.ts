/**
 * The deny-list of FR-108. The full "1,000 most common passwords" list is the intent; this is
 * the high-value core of it — what actually appears in credential dumps — plus the local and
 * product words a factory in Iraq would reach for first, and every plausible year. Extending
 * it is one edit here; nothing else in the system knows about it.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  '000000', '111111', '11111111', '112233', '121212', '123123',
  '123321', '1234', '12345', '123456', '1234567', '12345678',
  '123456789', '1234567890', '123456a', '123qwe', '131313', '159753',
  '1980', '1981', '1982', '1983', '1984', '1985',
  '1986', '1987', '1988', '1989', '1990', '1991',
  '1992', '1993', '1994', '1995', '1996', '1997',
  '1998', '1999', '1q2w3e', '1q2w3e4r', '1qaz2wsx', '2000',
  '2001', '2002', '2003', '2004', '2005', '2006',
  '2007', '2008', '2009', '2010', '2011', '2012',
  '2013', '2014', '2015', '2016', '2017', '2018',
  '2019', '2020', '2021', '2022', '2023', '2024',
  '2025', '2026', '2027', '2028', '2029', '2030',
  '654321', '666666', '7777777', '888888', '987654321', 'a123456',
  'aa123456', 'abc123', 'abcd1234', 'access', 'admin', 'admin1',
  'admin12', 'admin123', 'admin1234', 'admin2024', 'admin2025', 'admin2026',
  'andrew', 'asdfghjkl', 'ashley', 'baghdad', 'baseball', 'batman',
  'buster', 'changeme', 'charlie', 'computer', 'daniel', 'default',
  'donald', 'dragon', 'erbil', 'factory', 'flower', 'football',
  'freedom', 'george', 'google', 'guest', 'hannah', 'harley',
  'hello', 'hottie', 'hunter', 'iloveyou', 'internet', 'iraq',
  'jennifer', 'jesus', 'jordan', 'killer', 'kurdistan', 'letmein',
  'letmein123', 'login', 'lovely', 'loveme', 'maggie', 'master',
  'michael', 'michelle', 'mizan', 'monkey', 'mustang', 'mypassword',
  'ninja', 'p@ssw0rd', 'pa55word', 'pass', 'passw0rd', 'password',
  'password1', 'password12', 'password123', 'password1234', 'password2024', 'password2025',
  'password2026', 'photoshop', 'princess', 'princess1', 'qazwsx', 'qwe123',
  'qwerty', 'qwerty1', 'qwerty12', 'qwerty123', 'qwerty1234', 'qwerty2024',
  'qwerty2025', 'qwerty2026', 'qwertyuiop', 'ranger', 'robert', 'root',
  'samsung', 'secret', 'shadow', 'soccer', 'solo', 'starwars',
  'summer', 'sunshine', 'sunshine1', 'superman', 'temp', 'temp123',
  'test', 'test123', 'thomas', 'tigger', 'toor', 'trustme',
  'trustno1', 'user', 'user123', 'welcome', 'welcome1', 'welcome12',
  'welcome123', 'welcome1234', 'welcome2024', 'welcome2025', 'welcome2026', 'whatever',
  'zaq12wsx', 'zxcvbnm',
]);
