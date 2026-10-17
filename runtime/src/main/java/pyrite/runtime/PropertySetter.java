package pyrite.runtime;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks a method that was a Python {@code @x.setter}: Python code assigns it like a field
 * ({@code obj.total = 3}), the translation calls it ({@code obj.total(3)}).
 */
@Documented
@Retention(RetentionPolicy.SOURCE)
@Target(ElementType.METHOD)
public @interface PropertySetter {}
